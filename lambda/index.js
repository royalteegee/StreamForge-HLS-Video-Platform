/**
 * StreamForge Lambda Function
 *
 * Trigger:  S3 PUT event on raw-videos bucket (suffix: .mp4)
 * Process:  Download MP4 → FFmpeg → HLS (m3u8 + .ts segments) + Thumbnail → Upload to processed bucket
 * Notify:   POST to backend webhook with final playlist URL and thumbnail URL
 *
 * Required env vars:
 *   PROCESSED_BUCKET      — S3 bucket to write HLS output
 *   BACKEND_WEBHOOK_URL   — Full URL of your backend webhook endpoint
 *   WEBHOOK_SECRET        — Shared secret for webhook auth
 *   FFMPEG_PATH           — Path to ffmpeg binary (default: /opt/bin/ffmpeg)
 */

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const s3 = new S3Client({});

const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";

exports.handler = async (event) => {
  const record = event.Records[0];
  const rawBucket = record.s3.bucket.name;
  const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  const videoId = path.basename(objectKey, ".mp4");
  const tmpInput = `/tmp/${videoId}.mp4`;
  const tmpOutputDir = `/tmp/${videoId}_hls`;
  const tmpThumbnail = `/tmp/${videoId}_thumbnail.jpg`;

  console.log(`[StreamForge] Starting for videoId=${videoId}`);
  console.log(`[StreamForge] Source: s3://${rawBucket}/${objectKey}`);

  try {
    // Step 1: Download raw MP4 from S3
    console.log("[1/5] Downloading from S3...");
    await downloadFromS3(rawBucket, objectKey, tmpInput);
    console.log(`[1/5] Downloaded: ${getFileSizeMB(tmpInput)} MB`);

    // Step 2: Convert MP4 to HLS
    console.log("[2/5] Running FFmpeg HLS conversion...");
    fs.mkdirSync(tmpOutputDir, { recursive: true });
    runFFmpeg(tmpInput, tmpOutputDir);
    const outputFiles = fs.readdirSync(tmpOutputDir);
    console.log(`[2/5] Conversion complete — ${outputFiles.length} files produced`);

    // Step 3: Generate thumbnail at 2 second mark
    console.log("[3/5] Generating thumbnail...");
    generateThumbnail(tmpInput, tmpThumbnail);
    console.log("[3/5] Thumbnail generated");

    // Step 4: Upload HLS files and thumbnail to S3 in parallel
    console.log("[4/5] Uploading all files to S3...");
    const [thumbnailUrl] = await Promise.all([
      uploadThumbnail(tmpThumbnail, videoId),
      uploadHLSFiles(tmpOutputDir, outputFiles, videoId),
    ]);
    console.log(`[4/5] Upload complete — thumbnail: ${thumbnailUrl}`);

    // Step 5: Notify backend webhook
    const playlistUrl = buildPlaylistUrl(videoId);
    console.log("[5/5] Notifying backend webhook");
    await notifyBackend({ videoId, status: "ready", playlistUrl, thumbnailUrl });
    console.log("[5/5] Webhook delivered");

    return { statusCode: 200, body: JSON.stringify({ videoId, playlistUrl, thumbnailUrl }) };

  } catch (err) {
    console.error("[StreamForge] Failed:", err);
    await notifyBackend({ videoId, status: "failed", error: err.message })
      .catch((e) => console.error("Failed to notify backend:", e));
    throw err;
  } finally {
    cleanup([tmpInput, tmpOutputDir, tmpThumbnail]);
  }
};

async function downloadFromS3(bucket, key, destPath) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3.send(command);
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    response.Body.pipe(writeStream);
    response.Body.on("error", reject);
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
}

function runFFmpeg(inputPath, outputDir) {
  const playlistPath = path.join(outputDir, "playlist.m3u8");
  const segmentPattern = path.join(outputDir, "segment%03d.ts");
  const cmd = [
    FFMPEG_PATH,
    `-i "${inputPath}"`,
    "-codec: copy",
    "-start_number 0",
    "-hls_time 10",
    "-hls_list_size 0",
    `-hls_segment_filename "${segmentPattern}"`,
    "-f hls",
    `"${playlistPath}"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe", timeout: 4 * 60 * 1000 });
}

function generateThumbnail(inputPath, outputPath) {
  // -ss 00:00:02  — seek to 2 seconds into the video
  // -vframes 1    — extract exactly one frame
  // -vf scale=640:-1 — resize to 640px wide, keep aspect ratio
  // -q:v 2        — high quality JPEG (1=best, 31=worst)
  const cmd = [
    FFMPEG_PATH,
    `-ss 00:00:02`,
    `-i "${inputPath}"`,
    `-vframes 1`,
    `-vf scale=640:-1`,
    `-q:v 2`,
    `"${outputPath}"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe", timeout: 30 * 1000 });
}

async function uploadThumbnail(thumbnailPath, videoId) {
  const s3Key = `thumbnails/${videoId}/thumbnail.jpg`;
  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: s3Key,
      Body: fs.createReadStream(thumbnailPath),
      ContentType: "image/jpeg",
      CacheControl: "max-age=31536000",
    })
  );
  return buildFileUrl(s3Key);
}

async function uploadHLSFiles(outputDir, files, videoId) {
  const uploads = files.map((file) => {
    const filePath = path.join(outputDir, file);
    const s3Key = `hls/${videoId}/${file}`;
    const isPlaylist = file.endsWith(".m3u8");
    return s3.send(
      new PutObjectCommand({
        Bucket: PROCESSED_BUCKET,
        Key: s3Key,
        Body: fs.createReadStream(filePath),
        ContentType: isPlaylist ? "application/x-mpegURL" : "video/MP2T",
        CacheControl: isPlaylist ? "no-cache" : "max-age=31536000",
      })
    );
  });
  await Promise.all(uploads);
}

function buildPlaylistUrl(videoId) {
  return buildFileUrl(`hls/${videoId}/playlist.m3u8`);
}

function buildFileUrl(s3Key) {
  const region = process.env.AWS_REGION || "eu-central-1";
  return `https://${PROCESSED_BUCKET}.s3.${region}.amazonaws.com/${s3Key}`;
}

function notifyBackend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const webhookUrl = new URL(BACKEND_WEBHOOK_URL);
    const isHttps = webhookUrl.protocol === "https:";
    const options = {
      hostname: webhookUrl.hostname,
      port: webhookUrl.port || (isHttps ? 443 : 80),
      path: webhookUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-webhook-secret": WEBHOOK_SECRET,
      },
    };
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(responseBody || "{}"));
        } else {
          reject(new Error(`Webhook returned ${res.statusCode}: ${responseBody}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Webhook timed out")); });
    req.write(body);
    req.end();
  });
}

function getFileSizeMB(filePath) {
  return (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
}

function cleanup(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      }
    } catch (e) {
      console.warn(`Cleanup warning for ${p}:`, e.message);
    }
  }
}
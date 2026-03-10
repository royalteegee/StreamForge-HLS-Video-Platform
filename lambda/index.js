/**
 * StreamForge Lambda Function
 *
 * Trigger:  S3 PUT event on raw-videos bucket (suffix: .mp4)
 * Process:  Download MP4 → FFmpeg → HLS (m3u8 + .ts segments) → Upload to processed bucket
 * Notify:   POST to backend webhook with final playlist URL
 *
 * Required env vars:
 *   PROCESSED_BUCKET      — S3 bucket to write HLS output
 *   BACKEND_WEBHOOK_URL   — Full URL of your backend webhook endpoint
 *   WEBHOOK_SECRET        — Shared secret for webhook auth
 */

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET;
const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Path to ffmpeg binary provided by the Lambda layer
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";

exports.handler = async (event) => {
  // ── Parse S3 trigger event ────────────────────────────────────────────────
  const record = event.Records[0];
  const rawBucket = record.s3.bucket.name;
  const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  // Expect key format: "uploads/{videoId}.mp4"
  const videoId = path.basename(objectKey, ".mp4");
  const tmpInput = `/tmp/${videoId}.mp4`;
  const tmpOutputDir = `/tmp/${videoId}_hls`;

  console.log(`[StreamForge] Starting conversion for videoId=${videoId}`);
  console.log(`[StreamForge] Source: s3://${rawBucket}/${objectKey}`);

  try {
    // ── Step 1: Download raw MP4 from S3 to /tmp ──────────────────────────
    console.log("[1/4] Downloading from S3...");
    await downloadFromS3(rawBucket, objectKey, tmpInput);
    console.log(`[1/4] Downloaded: ${getFileSizeMB(tmpInput)} MB`);

    // ── Step 2: Run FFmpeg to convert MP4 → HLS ───────────────────────────
    console.log("[2/4] Running FFmpeg conversion...");
    fs.mkdirSync(tmpOutputDir, { recursive: true });
    runFFmpeg(tmpInput, tmpOutputDir);
    const outputFiles = fs.readdirSync(tmpOutputDir);
    console.log(`[2/4] Conversion complete — ${outputFiles.length} files produced`);

    // ── Step 3: Upload all HLS files to processed S3 bucket ───────────────
    console.log("[3/4] Uploading HLS files to S3...");
    await uploadHLSFiles(tmpOutputDir, outputFiles, videoId);
    console.log(`[3/4] All ${outputFiles.length} files uploaded`);

    // ── Step 4: Notify backend ─────────────────────────────────────────────
    const playlistUrl = buildPlaylistUrl(videoId);
    console.log(`[4/4] Notifying backend webhook: ${playlistUrl}`);
    await notifyBackend({ videoId, status: "ready", playlistUrl });
    console.log("[4/4] Webhook delivered");

    return { statusCode: 200, body: JSON.stringify({ videoId, playlistUrl }) };
  } catch (err) {
    console.error("[StreamForge] Conversion failed:", err);

    // Always notify backend of failure so UI shows error state
    await notifyBackend({
      videoId,
      status: "failed",
      error: err.message,
    }).catch((e) => console.error("Failed to notify backend of error:", e));

    throw err; // Re-throw so Lambda marks as error and CloudWatch captures it
  } finally {
    // ── Cleanup /tmp — Lambda shares /tmp across warm invocations ──────────
    cleanup([tmpInput, tmpOutputDir]);
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

  // FFmpeg flags:
  //   -codec: copy     — no re-encoding, just remux (fastest, preserves quality)
  //   -hls_time 10     — each .ts segment is ~10 seconds
  //   -hls_list_size 0 — keep ALL segments in the playlist (VOD mode)
  //   -f hls           — output HLS format
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

  execSync(cmd, { stdio: "pipe", timeout: 4 * 60 * 1000 }); // 4 min timeout
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
        // Make files publicly readable
        CacheControl: isPlaylist ? "no-cache" : "max-age=31536000",
      })
    );
  });

  await Promise.all(uploads);
}

function buildPlaylistUrl(videoId) {
  // If using CloudFront, swap this for your CloudFront domain
  return `https://${PROCESSED_BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/hls/${videoId}/playlist.m3u8`;
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
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Webhook request timed out"));
    });

    req.write(body);
    req.end();
  });
}

function getFileSizeMB(filePath) {
  const stats = fs.statSync(filePath);
  return (stats.size / (1024 * 1024)).toFixed(1);
}

function cleanup(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
      }
    } catch (e) {
      console.warn(`Cleanup warning for ${p}:`, e.message);
    }
  }
}
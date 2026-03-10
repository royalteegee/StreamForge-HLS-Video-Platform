const express = require("express");
const {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { v4: uuidv4 } = require("uuid");
const Video = require("../models/Video");
const { verifyWebhookSecret } = require("../middleware/auth");

const router = express.Router();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  requestChecksumCalculation: "when_required",
  responseChecksumValidation: "when_required",
});

const RAW_BUCKET = process.env.RAW_BUCKET;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/videos — all videos newest first
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).lean();
    res.json(videos);
  } catch (err) {
    console.error("GET /api/videos error:", err);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/videos/:id — single video (polled by frontend)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const video = await Video.findById(req.params.id).lean();
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json(video);
  } catch (err) {
    console.error("GET /api/videos/:id error:", err);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/presigned-url — single part upload (files under 50MB)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/presigned-url", async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });

  try {
    const videoId = uuidv4();
    const s3Key = `uploads/${videoId}.mp4`;

    const command = new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: s3Key,
      ContentType: "video/mp4",
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    await Video.create({ _id: videoId, title: title.trim(), rawKey: s3Key, status: "processing" });

    console.log(`🎬 New video (single-part): ${videoId} — "${title.trim()}"`);
    res.status(201).json({ videoId, presignedUrl });
  } catch (err) {
    console.error("POST /presigned-url error:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/multipart/start — initiate multipart upload (files over 50MB)
// Returns uploadId + one presigned URL per chunk
// ─────────────────────────────────────────────────────────────────────────────
router.post("/multipart/start", async (req, res) => {
  const { title, totalChunks } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  if (!totalChunks || totalChunks < 1) return res.status(400).json({ error: "totalChunks is required" });

  try {
    const videoId = uuidv4();
    const s3Key = `uploads/${videoId}.mp4`;

    // Initiate the multipart upload — S3 returns an uploadId
    const createCmd = new CreateMultipartUploadCommand({
      Bucket: RAW_BUCKET,
      Key: s3Key,
      ContentType: "video/mp4",
    });
    const { UploadId: uploadId } = await s3.send(createCmd);

    // Generate one presigned URL per part
    const presignedUrls = await Promise.all(
      Array.from({ length: totalChunks }, (_, i) =>
        getSignedUrl(
          s3,
          new UploadPartCommand({
            Bucket: RAW_BUCKET,
            Key: s3Key,
            UploadId: uploadId,
            PartNumber: i + 1,
          }),
          { expiresIn: 3600 } // 1 hour — large files take time
        )
      )
    );

    // Save video record to MongoDB
    await Video.create({ _id: videoId, title: title.trim(), rawKey: s3Key, status: "processing" });

    console.log(`🎬 New video (multipart, ${totalChunks} parts): ${videoId} — "${title.trim()}"`);
    res.status(201).json({ videoId, uploadId, presignedUrls });
  } catch (err) {
    console.error("POST /multipart/start error:", err);
    res.status(500).json({ error: "Failed to start multipart upload" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/multipart/complete — finalize multipart upload
// S3 assembles all parts into a single object
// ─────────────────────────────────────────────────────────────────────────────
router.post("/multipart/complete", async (req, res) => {
  const { videoId, uploadId, parts } = req.body;
  if (!videoId || !uploadId || !parts?.length) {
    return res.status(400).json({ error: "videoId, uploadId, and parts are required" });
  }

  try {
    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: RAW_BUCKET,
        Key: video.rawKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );

    console.log(`✅ Multipart complete: ${videoId} (${parts.length} parts assembled)`);
    res.json({ success: true, videoId });
  } catch (err) {
    console.error("POST /multipart/complete error:", err);
    res.status(500).json({ error: "Failed to complete multipart upload" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/webhook — called by Lambda after conversion
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook", verifyWebhookSecret, async (req, res) => {
  const { videoId, status, playlistUrl, thumbnailUrl, error } = req.body;
  if (!videoId || !status) return res.status(400).json({ error: "videoId and status are required" });

  try {
    const update = { status };
    if (playlistUrl) update.playlistUrl = playlistUrl;
    if (thumbnailUrl) update.thumbnailUrl = thumbnailUrl;
    if (error) update.errorMessage = error;

    const video = await Video.findByIdAndUpdate(videoId, update, { new: true });
    if (!video) return res.status(404).json({ error: "Video not found" });

    console.log(`✅ Webhook: videoId=${videoId} status=${status}`);
    res.json({ received: true, videoId, status });
  } catch (err) {
    console.error("POST /webhook error:", err);
    res.status(500).json({ error: "Failed to update video" });
  }
});

module.exports = router;
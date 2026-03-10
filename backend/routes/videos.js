const express = require("express");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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
// GET /api/videos
// Returns all videos sorted newest first
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
// GET /api/videos/:id
// Returns a single video (frontend polls this for status updates)
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
// POST /api/videos/presigned-url
// Creates a video record + returns a presigned S3 URL for direct upload
// Body: { title: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/presigned-url", async (req, res) => {
  const { title } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const videoId = uuidv4();
    const s3Key = `uploads/${videoId}.mp4`;

    // Generate S3 presigned URL (valid 15 minutes)
    const command = new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: s3Key,
      ContentType: "video/mp4",
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    // Persist video record to MongoDB with status "processing"
    await Video.create({
      _id: videoId,
      title: title.trim(),
      rawKey: s3Key,
      status: "processing",
    });

    console.log(`🎬 New video created: ${videoId} — "${title.trim()}"`);

    res.status(201).json({ videoId, presignedUrl });
  } catch (err) {
    console.error("POST /presigned-url error:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/webhook
// Called by Lambda after HLS conversion — updates video status in MongoDB
// Body: { videoId, status, playlistUrl?, error? }
// Secured by x-webhook-secret header
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook", verifyWebhookSecret, async (req, res) => {
  const { videoId, status, playlistUrl, error } = req.body;

  if (!videoId || !status) {
    return res.status(400).json({ error: "videoId and status are required" });
  }

  try {
    const update = { status };
    if (playlistUrl) update.playlistUrl = playlistUrl;
    if (error) update.errorMessage = error;

    const video = await Video.findByIdAndUpdate(videoId, update, { new: true });

    if (!video) {
      console.warn(`Webhook received for unknown videoId: ${videoId}`);
      return res.status(404).json({ error: "Video not found" });
    }

    console.log(`✅ Webhook received: videoId=${videoId} status=${status}`);

    res.json({ received: true, videoId, status });
  } catch (err) {
    console.error("POST /webhook error:", err);
    res.status(500).json({ error: "Failed to update video" });
  }
});

module.exports = router;
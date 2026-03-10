const mongoose = require("mongoose");

const VideoSchema = new mongoose.Schema(
  {
    _id: { type: String }, // We use videoId (uuid) as _id
    title: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },
    rawKey: {
      type: String, // S3 key of original MP4, e.g. "uploads/abc-123.mp4"
    },
    playlistUrl: {
      type: String, // Public HLS URL, e.g. "https://bucket.s3.../hls/id/playlist.m3u8"
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
    _id: false,       // we set _id manually
  }
);

module.exports = mongoose.model("Video", VideoSchema);
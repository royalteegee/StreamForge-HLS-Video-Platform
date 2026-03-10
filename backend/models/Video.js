const mongoose = require("mongoose");

const VideoSchema = new mongoose.Schema(
  {
    _id: { type: String },
    title: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },
    rawKey: { type: String },
    playlistUrl: { type: String, default: null },
    thumbnailUrl: { type: String, default: null }, // S3 URL of the generated thumbnail
    errorMessage: { type: String, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

module.exports = mongoose.model("Video", VideoSchema);
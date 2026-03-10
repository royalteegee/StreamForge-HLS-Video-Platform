const BASE_URL = import.meta.env.VITE_API_URL || "";

// ── Get all videos ──────────────────────────────────────────────────────────
export async function getVideos() {
  const res = await fetch(`${BASE_URL}/api/videos`);
  if (!res.ok) throw new Error("Failed to fetch videos");
  return res.json();
}

// ── Get single video ────────────────────────────────────────────────────────
export async function getVideo(id) {
  const res = await fetch(`${BASE_URL}/api/videos/${id}`);
  if (!res.ok) throw new Error("Video not found");
  return res.json();
}

// ── Full upload flow ────────────────────────────────────────────────────────
export async function uploadVideo({ file, title, onStep, onProgress, onSpeed }) {
  const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // Use multipart for files > 50MB
  const useMultipart = file.size > MULTIPART_THRESHOLD;

  if (useMultipart) {
    return uploadMultipart({ file, title, onStep, onProgress, onSpeed });
  } else {
    return uploadSinglePart({ file, title, onStep, onProgress, onSpeed });
  }
}

// ── Single part upload (files under 50MB) ───────────────────────────────────
async function uploadSinglePart({ file, title, onStep, onProgress, onSpeed }) {
  onStep?.("presign");
  onProgress?.(5);

  const initRes = await fetch(`${BASE_URL}/api/videos/presigned-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to get upload URL");
  }

  const { videoId, presignedUrl } = await initRes.json();

  onStep?.("upload");
  onProgress?.(10);

  await uploadToS3WithProgress(file, presignedUrl, (percent, speed, remaining) => {
    onProgress?.(10 + Math.round(percent * 0.65));
    onSpeed?.({ speed, remaining });
  });

  onStep?.("processing");
  onProgress?.(78);
  await pollForCompletion(videoId, onProgress);

  onStep?.("done");
  onProgress?.(100);
  return videoId;
}

// ── Multipart upload (files over 50MB) ─────────────────────────────────────
// Splits file into chunks, uploads in parallel batches of 5
async function uploadMultipart({ file, title, onStep, onProgress, onSpeed }) {
  onStep?.("presign");
  onProgress?.(5);

  // Dynamic chunk size — larger chunks for bigger files
  const CHUNK_SIZE = file.size > 200 * 1024 * 1024
    ? 20 * 1024 * 1024  // 20MB chunks for files over 200MB
    : 10 * 1024 * 1024; // 10MB chunks otherwise

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Step 1: Start multipart upload
  const initRes = await fetch(`${BASE_URL}/api/videos/multipart/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, totalChunks }),
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to start multipart upload");
  }

  const { videoId, uploadId, presignedUrls } = await initRes.json();

  // Step 2: Upload all chunks in parallel batches of 5
  onStep?.("upload");
  onProgress?.(10);

  const parts = [];
  let completedChunks = 0;
  let totalUploadedBytes = 0;
  const uploadStartTime = Date.now();

  const BATCH_SIZE = 5; // 5 concurrent chunk uploads
  for (let i = 0; i < totalChunks; i += BATCH_SIZE) {
    const batch = [];

    for (let j = i; j < Math.min(i + BATCH_SIZE, totalChunks); j++) {
      const start = j * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const partNumber = j + 1;
      const chunkSize = end - start;

      batch.push(
        uploadChunk(chunk, presignedUrls[j]).then((etag) => {
          completedChunks++;
          totalUploadedBytes += chunkSize;

          // Calculate upload speed and estimated time remaining
          const elapsedSeconds = (Date.now() - uploadStartTime) / 1000;
          const speed = totalUploadedBytes / elapsedSeconds; // bytes per second
          const remainingBytes = file.size - totalUploadedBytes;
          const remaining = remainingBytes / speed; // seconds remaining

          const uploadPercent = completedChunks / totalChunks;
          onProgress?.(10 + Math.round(uploadPercent * 65));
          onSpeed?.({ speed, remaining });

          return { PartNumber: partNumber, ETag: etag };
        })
      );
    }

    const batchResults = await Promise.all(batch);
    parts.push(...batchResults);
  }

  // Sort parts by part number before completing
  parts.sort((a, b) => a.PartNumber - b.PartNumber);

  // Step 3: Complete multipart upload — S3 assembles all chunks
  onProgress?.(78);
  const completeRes = await fetch(`${BASE_URL}/api/videos/multipart/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, uploadId, parts }),
  });

  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to complete multipart upload");
  }

  // Step 4: Poll for Lambda conversion
  onStep?.("processing");
  onProgress?.(80);
  await pollForCompletion(videoId, onProgress);

  onStep?.("done");
  onProgress?.(100);
  return videoId;
}

// ── Upload single chunk to S3, returns ETag ─────────────────────────────────
function uploadChunk(chunk, presignedUrl) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presignedUrl);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        resolve(etag);
      } else {
        reject(new Error(`Chunk upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during chunk upload"));
    xhr.send(chunk);
  });
}

// ── Single part S3 upload with XHR progress + speed tracking ───────────────
function uploadToS3WithProgress(file, presignedUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = e.loaded / e.total;
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const speed = e.loaded / elapsedSeconds; // bytes per second
        const remainingBytes = e.total - e.loaded;
        const remaining = remainingBytes / speed; // seconds remaining
        onProgress?.(percent, speed, remaining);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Network error during S3 upload"));
    xhr.open("PUT", presignedUrl);
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.send(file);
  });
}

// ── Poll backend every 5s until video is ready or failed ───────────────────
async function pollForCompletion(videoId, onProgress) {
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes max
  const INTERVAL_MS = 5000;
  const start = Date.now();
  let progressTick = 80;

  while (Date.now() - start < MAX_WAIT_MS) {
    await sleep(INTERVAL_MS);

    const res = await fetch(`${BASE_URL}/api/videos/${videoId}`);
    if (!res.ok) continue;

    const video = await res.json();
    if (video.status === "ready") return video;
    if (video.status === "failed") throw new Error("Video conversion failed on Lambda.");

    progressTick = Math.min(progressTick + 3, 95);
    onProgress?.(progressTick);
  }

  throw new Error("Conversion timed out. Check Lambda logs.");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
}

export function formatTimeRemaining(seconds) {
  if (!seconds || !isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${mins}m ${secs}s remaining`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
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
export async function uploadVideo({ file, title, onStep, onProgress }) {
  // Step 1: Get presigned URL from backend
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

  // Step 2: Upload directly to S3 with progress tracking
  onStep?.("upload");
  onProgress?.(10);

  await uploadToS3(file, presignedUrl, (percent) => {
    // Map S3 upload progress to 10–70%
    onProgress?.(10 + Math.round(percent * 0.6));
  });

  // Step 3: Poll for Lambda conversion to finish
  onStep?.("processing");
  onProgress?.(75);

  await pollForCompletion(videoId, onProgress);

  onStep?.("done");
  onProgress?.(100);

  return videoId;
}

// Upload file to S3 presigned URL with XHR for progress events
function uploadToS3(file, presignedUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
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

// Poll backend every 5s until video status is ready or failed
async function pollForCompletion(videoId, onProgress) {
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
  const INTERVAL_MS = 5000;
  const start = Date.now();
  let progressTick = 75;

  while (Date.now() - start < MAX_WAIT_MS) {
    await sleep(INTERVAL_MS);

    const res = await fetch(`${BASE_URL}/api/videos/${videoId}`);
    if (!res.ok) continue;

    const video = await res.json();

    if (video.status === "ready") return video;
    if (video.status === "failed") throw new Error("Video conversion failed on Lambda.");

    // Slowly increment progress while waiting
    progressTick = Math.min(progressTick + 3, 95);
    onProgress?.(progressTick);
  }

  throw new Error("Conversion timed out. Check Lambda logs.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
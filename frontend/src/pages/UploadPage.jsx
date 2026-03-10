import { useState, useRef } from "react";
import { uploadVideo, formatSpeed, formatTimeRemaining } from "../utils/api";

const STEPS = [
  { key: "presign", label: "Requesting upload URL" },
  { key: "upload", label: "Uploading to S3" },
  { key: "processing", label: "Converting to HLS (Lambda)" },
  { key: "done", label: "Ready to stream" },
];

export default function UploadPage({ onDone }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState(null);
  const [speedInfo, setSpeedInfo] = useState(null); // { speed, remaining }
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const fileRef = useRef();

  const formatSize = (bytes) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleFile = (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("Please select a video file.");
      return;
    }
    setFile(f);
    setError(null);
    if (!title) setTitle(f.name.replace(/\.[^/.]+$/, ""));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleSubmit = async () => {
    if (!file || !title.trim()) return;
    setUploading(true);
    setError(null);
    setProgress(0);
    setSpeedInfo(null);

    try {
      await uploadVideo({
        file,
        title: title.trim(),
        onStep: setCurrentStep,
        onProgress: setProgress,
        onSpeed: setSpeedInfo,
      });
      setDone(true);
    } catch (err) {
      setError(err.message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const isStepDone = (key) => {
    if (done) return true;
    const idx = STEPS.findIndex((s) => s.key === key);
    const cur = STEPS.findIndex((s) => s.key === currentStep);
    return idx < cur;
  };

  if (done) {
    return (
      <div className="upload-page">
        <div className="page-header">
          <div className="page-title">Upload Complete 🎉</div>
          <div className="page-subtitle">Your video has been converted and is ready to stream.</div>
        </div>
        <div style={{ padding: "32px", background: "var(--surface)", border: "1px solid var(--success)", borderRadius: "var(--radius)", marginBottom: "24px" }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>✅</div>
          <div style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: "18px", color: "var(--success)", marginBottom: "8px" }}>{title}</div>
          <div style={{ fontSize: "13px", color: "var(--text2)" }}>HLS conversion complete — video is in your library.</div>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <button className="btn-primary" onClick={onDone}>Go to Library →</button>
          <button className="btn-ghost" onClick={() => { setFile(null); setTitle(""); setDone(false); setCurrentStep(null); setProgress(0); setSpeedInfo(null); }}>
            Upload Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="upload-page">
      <div className="page-header">
        <div className="page-title">Upload Video</div>
        <div className="page-subtitle">MP4 files are converted to HLS for adaptive streaming.</div>
      </div>

      {!uploading ? (
        <>
          <div
            className={`dropzone ${dragOver ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !file && fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept="video/mp4,video/*" onChange={(e) => handleFile(e.target.files[0])} style={{ display: "none" }} />
            {file ? (
              <div className="selected-file" style={{ justifyContent: "center", background: "transparent", border: "none" }}>
                <span>🎬</span>
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatSize(file.size)}</span>
                <button style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: "16px" }} onClick={(e) => { e.stopPropagation(); setFile(null); setTitle(""); }}>✕</button>
              </div>
            ) : (
              <>
                <span className="dropzone-icon">⬆</span>
                <div className="dropzone-title">Drop your video here</div>
                <div className="dropzone-sub">or click to browse — MP4, MOV, AVI supported</div>
              </>
            )}
          </div>

          {file && (
            <div className="upload-form">
              <div className="field">
                <label>Video Title</label>
                <input type="text" placeholder="Enter a title..." value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>

              {error && (
                <div style={{ padding: "10px 14px", background: "rgba(255,71,71,0.08)", border: "1px solid var(--error)", borderRadius: "var(--radius-sm)", color: "var(--error)", fontSize: "13px" }}>
                  ⚠ {error}
                </div>
              )}

              {/* Warn user if file is large */}
              {file.size > 50 * 1024 * 1024 && (
                <div style={{ padding: "10px 14px", background: "rgba(255,193,71,0.06)", border: "1px solid rgba(255,193,71,0.2)", borderRadius: "var(--radius-sm)", fontSize: "12px", color: "var(--warning)" }}>
                  ⚡ Large file ({formatSize(file.size)}) — will use multipart upload with 5 parallel chunks.
                </div>
              )}

              <button className="btn-primary" disabled={!title.trim()} onClick={handleSubmit}>
                Start Upload & Convert →
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="upload-progress">
          {/* Progress bar */}
          <div className="progress-label">
            <span className="step">
              {currentStep === "processing" ? "Lambda converting..." : currentStep === "upload" ? "Uploading to S3..." : "Preparing..."}
            </span>
            <span>{progress}%</span>
          </div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>

          {/* Speed + time remaining — only shown during upload step */}
          {currentStep === "upload" && speedInfo && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px", fontSize: "12px", color: "var(--text2)" }}>
              <span>⚡ {formatSpeed(speedInfo.speed)}</span>
              <span>{formatTimeRemaining(speedInfo.remaining)}</span>
            </div>
          )}

          {/* Step indicators */}
          <div className="upload-steps" style={{ marginTop: "20px" }}>
            {STEPS.map((step) => {
              const stepDone = isStepDone(step.key);
              const active = currentStep === step.key;
              return (
                <div key={step.key} className={`upload-step ${stepDone ? "done" : ""} ${active ? "active" : ""}`}>
                  <span className="step-icon">
                    {stepDone ? "✓" : active ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} /> : "○"}
                  </span>
                  {step.label}
                </div>
              );
            })}
          </div>

          {currentStep === "processing" && (
            <div style={{ marginTop: "16px", padding: "10px 14px", background: "rgba(255,193,71,0.06)", border: "1px solid rgba(255,193,71,0.2)", borderRadius: "var(--radius-sm)", fontSize: "12px", color: "var(--warning)" }}>
              ⚡ Lambda is running FFmpeg — this takes 1–3 minutes depending on video length.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
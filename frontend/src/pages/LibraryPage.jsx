import { useState, useEffect } from "react";
import { getVideos } from "../utils/api";

export default function LibraryPage({ onWatch }) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchVideos = async () => {
    try {
      const data = await getVideos();
      setVideos(data);
    } catch (err) {
      console.error("Failed to load videos:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVideos();
    // Poll every 10s to catch videos finishing processing
    const interval = setInterval(fetchVideos, 10000);
    return () => clearInterval(interval);
  }, []);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="page-title">Your Library</div>
          <div className="page-subtitle">
            {videos.length > 0 ? `${videos.length} video${videos.length !== 1 ? "s" : ""}` : "No videos yet"}
          </div>
        </div>
        <button
          className="btn-ghost"
          onClick={fetchVideos}
          style={{ fontSize: "12px", gap: "6px" }}
        >
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="library-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
              <div className="skeleton" style={{ aspectRatio: "16/9", width: "100%" }} />
              <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div className="skeleton" style={{ height: 18, width: "70%", borderRadius: 4 }} />
                <div className="skeleton" style={{ height: 14, width: "40%", borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="library-grid">
          {videos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🎬</div>
              <div className="empty-state-title">No videos yet</div>
              <div className="empty-state-sub">Upload your first video to get started.</div>
            </div>
          ) : (
            videos.map((video) => (
              <VideoCard
                key={video._id || video.videoId}
                video={video}
                onClick={() => video.status === "ready" && onWatch(video)}
                formatDate={formatDate}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function VideoCard({ video, onClick, formatDate }) {
  const isReady = video.status === "ready";
  const isProcessing = video.status === "processing";
  const isFailed = video.status === "failed";

  return (
    <div
      className={`video-card ${!isReady ? "video-card-disabled" : ""}`}
      onClick={onClick}
      style={{ cursor: isReady ? "pointer" : "default" }}
    >
      <div className="video-thumb">
        {isProcessing && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <div className="spinner" />
            <span style={{ fontSize: "11px", color: "var(--warning)", letterSpacing: "0.06em" }}>CONVERTING</span>
          </div>
        )}
        {isFailed && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <span style={{ fontSize: "28px" }}>⚠</span>
            <span style={{ fontSize: "11px", color: "var(--error)", letterSpacing: "0.06em" }}>FAILED</span>
          </div>
        )}
        {isReady && (
          <div className="thumb-play">▶</div>
        )}
      </div>

      <div className="video-card-body">
        <div className="video-card-title">{video.title}</div>
        <div className="video-card-meta">
          <span className="video-card-date">
            {video.createdAt ? formatDate(video.createdAt) : "—"}
          </span>
          <span className={`status-badge ${video.status}`}>
            <span className="status-dot" />
            {video.status}
          </span>
        </div>
      </div>
    </div>
  );
}
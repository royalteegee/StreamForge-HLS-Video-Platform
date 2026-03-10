import { useEffect, useRef, useState } from "react";

export default function PlayerPage({ video, onBack }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !video.playlistUrl) return;

    const setup = async () => {
      if (window.Hls) {
        initHls(videoEl, window.Hls);
      } else {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@latest";
        script.onload = () => initHls(videoEl, window.Hls);
        document.head.appendChild(script);
      }
    };

    setup();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [video.playlistUrl]);

  const initHls = (videoEl, Hls) => {
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(video.playlistUrl);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPlayerReady(true);
        videoEl.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) setPlayerError("Playback error: " + data.type);
      });
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = video.playlistUrl;
      videoEl.addEventListener("loadedmetadata", () => {
        setPlayerReady(true);
        videoEl.play().catch(() => {});
      });
    } else {
      setPlayerError("HLS playback is not supported in this browser.");
    }
  };

  return (
    <div className="player-page">
      <div className="player-back">
        <button className="btn-ghost" onClick={onBack}>← Back to Library</button>
      </div>

      {/* Constrain video to viewport — never taller than 60vh */}
      <div className="player-wrapper">
        {playerError ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "var(--error)" }}>
            <span style={{ fontSize: "32px" }}>⚠</span>
            <span style={{ fontSize: "14px" }}>{playerError}</span>
          </div>
        ) : (
          <>
            {!playerReady && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", zIndex: 1 }}>
                <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
              </div>
            )}
            <video
              ref={videoRef}
              controls
              playsInline
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          </>
        )}
      </div>

      <div className="player-meta">
        <div>
          <div className="player-title">{video.title}</div>
          <div className="player-info">
            {video.createdAt
              ? new Date(video.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
              : ""}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "10px", color: "var(--text3)", marginBottom: "4px", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            HLS Playlist URL
          </div>
          <div className="player-url">{video.playlistUrl}</div>
        </div>
      </div>
    </div>
  );
}
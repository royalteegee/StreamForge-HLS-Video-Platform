import { useState } from "react";
import UploadPage from "./pages/UploadPage";
import LibraryPage from "./pages/LibraryPage";
import PlayerPage from "./pages/PlayerPage";
import "./index.css";

export default function App() {
  const [page, setPage] = useState("library");
  const [selectedVideo, setSelectedVideo] = useState(null);

  const navigate = (target, data = null) => {
    setSelectedVideo(data);
    setPage(target);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo" onClick={() => navigate("library")}>
            <span className="logo-icon">▶</span>
            <span className="logo-text">STREAMFORGE</span>
          </div>
          <nav className="header-nav">
            <button
              className={`nav-btn ${page === "library" ? "active" : ""}`}
              onClick={() => navigate("library")}
            >
              Library
            </button>
            <button
              className={`nav-btn ${page === "upload" ? "active" : ""}`}
              onClick={() => navigate("upload")}
            >
              + Upload
            </button>
          </nav>
        </div>
      </header>

      <main className="app-main">
        {page === "library" && (
          <LibraryPage onWatch={(video) => navigate("player", video)} />
        )}
        {page === "upload" && (
          <UploadPage onDone={() => navigate("library")} />
        )}
        {page === "player" && selectedVideo && (
          <PlayerPage video={selectedVideo} onBack={() => navigate("library")} />
        )}
      </main>
    </div>
  );
}
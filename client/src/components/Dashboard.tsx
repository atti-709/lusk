import { useState, useEffect } from "react";
import type { RecentProject } from "@lusk/shared";

const STATE_LABELS: Record<string, string> = {
  IDLE: "No Video",
  UPLOADING: "Uploaded",
  TRANSCRIBING: "Transcribing",
  ALIGNING: "Aligning",
  READY: "Ready",
  RENDERING: "Rendering",
  EXPORTED: "Exported",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

/** Display name: videoName if set, otherwise basename of .lusk file without extension. */
function getProjectDisplayName(p: RecentProject): string {
  if (p.videoName?.trim()) return p.videoName;
  const parts = p.projectPath.replace(/\\/g, "/").split("/");
  const base = parts[parts.length - 1] ?? "project";
  const name = base.replace(/\.lusk$/i, "").trim();
  return name || "Untitled Project";
}

interface DashboardProps {
  onOpenProject: (projectId: string, projectPath: string) => void;
  onNewProject: () => void;
  onOpenFile: () => void;
  whisperxAvailable?: boolean;
}

export function Dashboard({ onOpenProject, onNewProject, onOpenFile, whisperxAvailable = true }: DashboardProps) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects/recent", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: RecentProject[]) => {
        setProjects(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleRemove = async (projectId: string) => {
    await fetch(`/api/projects/recent/${projectId}`, { method: "DELETE" });
    setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
  };

  const handleClearCache = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/projects/${projectId}/cache`, { method: "DELETE" });
    (e.target as HTMLButtonElement).textContent = "Cleared!";
    setTimeout(() => {
      (e.target as HTMLButtonElement).textContent = "Clear cache";
    }, 2000);
  };

  if (loading) return <div className="connecting">Loading</div>;

  return (
    <div className="dashboard">
      {!whisperxAvailable && (
        <div className="dashboard-warning">
          <strong>WhisperX not available</strong> — transcription is disabled. Install it with <code>pip3 install whisperx</code> and restart the app. You can still open existing projects.
        </div>
      )}
      <div className="dashboard-actions">
        <button className="primary" onClick={onNewProject} disabled={!whisperxAvailable} title={!whisperxAvailable ? "WhisperX is required to create new projects" : undefined}>
          + New Project
        </button>
        <button className="secondary" onClick={onOpenFile}>
          Open Project...
        </button>
      </div>

      {projects.length === 0 && (
        <div className="dashboard-empty">
          <p>No recent projects</p>
          <p className="dashboard-hint">Create a new project or open an existing .lusk file</p>
        </div>
      )}

      {projects.length > 0 && (
        <>
          <h2 className="dashboard-section-title">Recent Projects</h2>
          <div className="project-grid">
            {projects.map((p) => (
              <div
                key={p.projectId}
                className={`project-card ${p.missing ? "project-card--missing" : ""}`}
                onClick={() => !p.missing && onOpenProject(p.projectId, p.projectPath)}
                role="button"
                tabIndex={0}
              >
                <div className="project-card__thumb">
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" />
                  ) : (
                    <div className="project-card__thumb-placeholder" />
                  )}
                </div>
                <div className="project-card__info">
                  <span className="project-card__name">{getProjectDisplayName(p)}</span>
                  <span className="project-card__meta">
                    <span className={`state-badge state-badge--${p.state.toLowerCase()}`}>
                      {STATE_LABELS[p.state] ?? p.state}
                    </span>
                    <span className="project-card__time">{formatTime(p.updatedAt)}</span>
                  </span>
                </div>
                {!p.missing && (
                  <button
                    className="project-card__clear-cache"
                    onClick={(e) => handleClearCache(p.projectId, e)}
                  >
                    Clear cache
                  </button>
                )}
                {p.missing && (
                  <div className="project-card__missing">
                    <span>File not found</span>
                    <button
                      className="project-card__remove"
                      onClick={(e) => { e.stopPropagation(); handleRemove(p.projectId); }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

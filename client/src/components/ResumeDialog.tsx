import { useState } from "react";
import type { SessionSummary } from "@lusk/shared";
import "./ResumeDialog.css";

const STATE_LABELS: Record<string, string> = {
  UPLOADING: "Uploaded",
  TRANSCRIBING: "Transcribing",
  ALIGNING: "Aligning",
  ANALYZING: "Analyzing",
  READY: "Ready to edit",
  RENDERING: "Rendering",
  EXPORTED: "Exported",
};

const STATE_COLORS: Record<string, string> = {
  READY: "badge-ready",
  EXPORTED: "badge-exported",
  RENDERING: "badge-rendering",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

interface ProjectCardProps {
  session: SessionSummary;
  onOpen: () => void;
  onDelete: () => void;
}

function ProjectCard({ session: s, onOpen, onDelete }: ProjectCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
    } else {
      setConfirmDelete(true);
    }
  };

  const handleCardClick = () => {
    if (confirmDelete) {
      setConfirmDelete(false);
    } else {
      onOpen();
    }
  };

  return (
    <div
      className={`project-card ${confirmDelete ? "confirm-delete" : ""}`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleCardClick()}
    >
      {s.videoUrl && (
        <div className="project-card-thumb">
          <video
            src={s.videoUrl}
            muted
            playsInline
            preload="metadata"
          />
        </div>
      )}

      <div className="project-card-body">
        <div className="project-card-top">
          <span className={`project-badge ${STATE_COLORS[s.state] ?? "badge-processing"}`}>
            {STATE_LABELS[s.state] ?? s.state}
          </span>
          <button
            className={`project-delete-btn ${confirmDelete ? "is-confirm" : ""}`}
            onClick={handleDelete}
            title={confirmDelete ? "Click again to confirm" : "Delete project"}
          >
            {confirmDelete ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
          </button>
        </div>

        <div className="project-card-name">{s.videoName ?? s.sessionId.slice(0, 8)}</div>
        <div className="project-card-time">{formatTime(s.createdAt)}</div>
      </div>
    </div>
  );
}

interface ResumeDialogProps {
  sessions: SessionSummary[];
  onResume: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onNew: () => void;
  onImport: (file: File) => void;
}

export function ResumeDialog({ sessions, onResume, onDelete, onNew, onImport }: ResumeDialogProps) {
  return (
    <div className="resume-page">
      <div className="resume-header">
        <h2>Projects</h2>
        <div className="resume-header-actions">
          <label className="secondary import-btn">
            Import project
            <input type="file" accept=".lusk" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImport(file);
            }} hidden />
          </label>
          <button className="primary" onClick={onNew}>
            + New project
          </button>
        </div>
      </div>

      <div className="project-grid">
        {sessions.map((s) => (
          <ProjectCard
            key={s.sessionId}
            session={s}
            onOpen={() => onResume(s.sessionId)}
            onDelete={() => onDelete(s.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

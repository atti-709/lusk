import type { SessionSummary } from "@lusk/shared";
import "./ResumeDialog.css";

const STATE_LABELS: Record<string, string> = {
  UPLOADING: "Uploaded",
  TRANSCRIBING: "Transcribing...",
  ALIGNING: "Aligning...",
  ANALYZING: "Analyzing...",
  READY: "Ready to edit",
  RENDERING: "Rendering...",
  EXPORTED: "Exported",
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

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface ResumeDialogProps {
  sessions: SessionSummary[];
  onResume: (sessionId: string) => void;
  onNew: () => void;
}

export function ResumeDialog({ sessions, onResume, onNew }: ResumeDialogProps) {
  return (
    <div className="resume-dialog">
      <h2>Welcome back</h2>

      <div className="resume-sessions">
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            className="resume-card"
            onClick={() => onResume(s.sessionId)}
          >
            <div className="resume-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </div>
            <div className="resume-card-info">
              <div className="resume-card-state">
                {STATE_LABELS[s.state] ?? s.state}
              </div>
              <div className="resume-card-time">
                {s.sessionId.slice(0, 8)} &middot; {formatTime(s.createdAt)}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="resume-divider">
        <span>or</span>
      </div>

      <button className="primary" onClick={onNew}>
        Start new project
      </button>
    </div>
  );
}

import { useState } from "react";
import type { PipelineState } from "@lusk/shared";
import "./PipelineStepper.css";

const STEPS: { state: PipelineState; label: string }[] = [
  { state: "UPLOADING", label: "Upload" },
  { state: "TRANSCRIBING", label: "Transcribe" },
  { state: "ALIGNING", label: "Align" },
  { state: "ANALYZING", label: "Analyze" },
  { state: "READY", label: "Review" },
  { state: "RENDERING", label: "Render" },
  { state: "EXPORTED", label: "Export" },
];

const STATE_ORDER: PipelineState[] = STEPS.map((s) => s.state);

interface PipelineStepperProps {
  currentState: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  onTranscribe: (sourceScript?: string) => void;
}

function getStepStatus(
  stepState: PipelineState,
  currentState: PipelineState
): "done" | "active" | "pending" {
  const stepIdx = STATE_ORDER.indexOf(stepState);
  const currentIdx = STATE_ORDER.indexOf(currentState);
  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "active";
  return "pending";
}

export function PipelineStepper({
  currentState,
  progress,
  message,
  videoUrl,
  onTranscribe,
}: PipelineStepperProps) {
  const [scriptText, setScriptText] = useState("");

  const isProcessing = [
    "TRANSCRIBING",
    "ALIGNING",
    "ANALYZING",
    "RENDERING",
  ].includes(currentState);

  return (
    <div className="pipeline">
      {/* Step track */}
      <div className="step-track">
        {STEPS.map(({ state, label }, i) => {
          const status = getStepStatus(state, currentState);
          return (
            <div key={state} className={`step ${status}`}>
              <div className="step-dot">
                {status === "done" && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              {i < STEPS.length - 1 && <div className="step-line" />}
              <span className="step-label">{label}</span>
            </div>
          );
        })}
      </div>

      {/* Video preview */}
      {videoUrl && (
        <div className="video-preview">
          <video src={videoUrl} controls />
        </div>
      )}

      {/* Progress area */}
      {isProcessing && (
        <div className="progress-area">
          <div className="progress-header">
            <span className="progress-message">{message}</span>
            <span className="progress-pct">{progress}%</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Status message when not processing */}
      {!isProcessing && message && (
        <p className="status-message">{message}</p>
      )}

      {/* Action area */}
      <div className="actions">
        {currentState === "UPLOADING" && (
          <div className="script-section">
            <label className="script-label" htmlFor="source-script">
              Original text <span className="optional">(optional)</span>
            </label>
            <textarea
              id="source-script"
              className="script-textarea"
              placeholder="Paste the original script here to improve caption accuracy (diacritics, spelling)…"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              rows={5}
            />
            <button
              className="primary"
              onClick={() => onTranscribe(scriptText.trim() || undefined)}
            >
              Start Transcription
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import type { PipelineState } from "@lusk/shared";
import { AlignStep } from "./AlignStep";
import "./PipelineStepper.css";

const STEPS: { state: PipelineState; label: string }[] = [
  { state: "UPLOADING", label: "Upload" },
  { state: "TRANSCRIBING", label: "Transcribe" },
  { state: "ALIGNING", label: "Align & Analyze" },
  { state: "READY", label: "Review" },
];

const STATE_ORDER: PipelineState[] = STEPS.map((s) => s.state);

interface PipelineStepperProps {
  currentState: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  sessionId: string;
  onTranscribe: () => void;
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
  sessionId,
  onTranscribe,
}: PipelineStepperProps) {
  const isProcessing =
    (currentState === "TRANSCRIBING") ||
    (currentState === "ALIGNING" && progress < 100) ||
    (currentState === "RENDERING");

  const showAlignStep = currentState === "ALIGNING" && progress === 100;

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

      {/* Status message when not processing and not in align step */}
      {!isProcessing && !showAlignStep && message && (
        <p className="status-message">{message}</p>
      )}

      {/* AlignStep manual workflow */}
      {showAlignStep && (
        <AlignStep sessionId={sessionId} />
      )}

      {/* Action area */}
      <div className="actions">
        {currentState === "UPLOADING" && (
          <button className="primary" onClick={() => onTranscribe()}>
            Start Transcription
          </button>
        )}
      </div>
    </div>
  );
}

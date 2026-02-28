import type { PipelineState } from "@lusk/shared";
import { AlignStep } from "./AlignStep";
import "./PipelineStepper.css";

export type ReadySubView = "review" | "clips";

// Steps now include both pipeline states and ready sub-views
const STEPS: { id: string; label: string }[] = [
  { id: "UPLOADING", label: "Upload" },
  { id: "TRANSCRIBING", label: "Transcribe" },
  { id: "ALIGNING", label: "Align & Analyze" },
  { id: "REVIEW", label: "Review" },
  { id: "CLIPS", label: "Clips" },
];

interface PipelineStepperProps {
  currentState: PipelineState;
  progress: number;
  message: string;
  videoUrl: string | null;
  sessionId: string;
  readySubView?: ReadySubView;
  whisperxAvailable?: boolean;
  geminiAvailable?: boolean;
}

function getActiveStepId(
  state: PipelineState,
  subView?: ReadySubView
): string {
  if (state === "READY") {
    return subView === "clips" ? "CLIPS" : "REVIEW";
  }
  return state;
}

function getStepStatus(
  stepId: string,
  activeStepId: string
): "done" | "active" | "pending" {
  const stepIdx = STEPS.findIndex((s) => s.id === stepId);
  const activeIdx = STEPS.findIndex((s) => s.id === activeStepId);
  if (stepIdx < activeIdx) return "done";
  if (stepIdx === activeIdx) return "active";
  return "pending";
}

export function PipelineStepper({
  currentState,
  progress,
  message,
  videoUrl,
  sessionId,
  readySubView,
  whisperxAvailable = true,
  geminiAvailable = false,
}: PipelineStepperProps) {
  const isProcessing =
    (currentState === "TRANSCRIBING") ||
    (currentState === "ALIGNING" && progress < 100) ||
    (currentState === "RENDERING");

  const showAlignStep = currentState === "ALIGNING" && progress === 100;
  const activeStepId = getActiveStepId(currentState, readySubView);

  return (
    <div className="pipeline">
      {/* Step track */}
      <div className="step-track">
        {STEPS.map(({ id, label }, i) => {
          const status = getStepStatus(id, activeStepId);
          return (
            <div key={id} className={`step ${status}`}>
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

      {/* Video preview (only during pre-READY pipeline) */}
      {videoUrl && !showAlignStep && currentState !== "READY" && (
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
      {!isProcessing && !showAlignStep && currentState !== "READY" && message && (
        <p className="status-message">{message}</p>
      )}

      {/* AlignStep manual workflow */}
      {showAlignStep && (
        <AlignStep sessionId={sessionId} geminiAvailable={geminiAvailable} />
      )}

      {/* Action area */}
      <div className="actions">
        {currentState === "UPLOADING" && !whisperxAvailable && (
          <p className="status-message">WhisperX is not installed. Run <code>pip3 install whisperx</code> and restart the app.</p>
        )}
      </div>
    </div>
  );
}

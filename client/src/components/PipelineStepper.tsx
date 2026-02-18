import type { PipelineState } from "@lusk/shared";

const STEPS: { state: PipelineState; label: string }[] = [
  { state: "UPLOADING", label: "Upload" },
  { state: "TRANSCRIBING", label: "Transcribe" },
  { state: "ALIGNING", label: "Align" },
  { state: "ANALYZING", label: "Analyze" },
  { state: "READY", label: "Ready" },
  { state: "RENDERING", label: "Render" },
  { state: "EXPORTED", label: "Exported" },
];

const STATE_ORDER: PipelineState[] = STEPS.map((s) => s.state);

interface PipelineStepperProps {
  currentState: PipelineState;
  progress: number;
  message: string;
  outputUrl: string | null;
  onTranscribe: () => void;
  onRender: () => void;
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
  outputUrl,
  onTranscribe,
  onRender,
}: PipelineStepperProps) {
  return (
    <div className="pipeline-stepper">
      <div className="steps">
        {STEPS.map(({ state, label }) => {
          const status = getStepStatus(state, currentState);
          return (
            <div key={state} className={`step ${status}`}>
              <div className="step-indicator">
                {status === "done" ? "✓" : status === "active" ? "●" : "○"}
              </div>
              <span className="step-label">{label}</span>
            </div>
          );
        })}
      </div>

      <div className="progress-section">
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="progress-text">{progress}%</span>
      </div>

      {message && <p className="status-message">{message}</p>}

      <div className="actions">
        {currentState === "UPLOADING" && (
          <button onClick={onTranscribe}>Start Transcription</button>
        )}
        {currentState === "READY" && (
          <button onClick={onRender}>Render Video</button>
        )}
        {currentState === "EXPORTED" && outputUrl && (
          <a href={outputUrl} download className="download-link">
            Download Video
          </a>
        )}
      </div>
    </div>
  );
}

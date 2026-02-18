import { useState, useCallback, useEffect } from "react";
import { UploadZone } from "./components/UploadZone";
import { PipelineStepper } from "./components/PipelineStepper";
import { StudioView } from "./components/StudioView";
import { useSSE } from "./hooks/useSSE";
import type { CaptionWord } from "@lusk/shared";
import "./App.css";

const STUDIO_STATES = ["READY", "RENDERING", "EXPORTED"];

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { state } = useSSE(sessionId);
  const [captions, setCaptions] = useState<CaptionWord[]>([]);
  const [durationMs, setDurationMs] = useState(60000);

  const showStudio = state && STUDIO_STATES.includes(state.state);

  // Fetch captions when entering studio
  useEffect(() => {
    if (!sessionId || !showStudio) return;

    fetch(`/api/project/${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.captions) setCaptions(data.captions);
      })
      .catch(() => {});
  }, [sessionId, showStudio]);

  // Get video duration from the video element
  const handleVideoMetadata = useCallback((duration: number) => {
    setDurationMs(duration * 1000);
  }, []);

  const handleUploadComplete = useCallback((id: string) => {
    setSessionId(id);
  }, []);

  const handleTranscribe = useCallback(async () => {
    if (!sessionId) return;
    await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }, [sessionId]);

  const handleRender = useCallback(async () => {
    if (!sessionId) return;
    await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }, [sessionId]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-mark">L</div>
        <h1>Lusk</h1>
      </header>

      {!sessionId && (
        <div className="upload-hero">
          <p className="tagline">
            Create viral shorts from Slovak video podcasts
          </p>
          <UploadZone onUploadComplete={handleUploadComplete} />
        </div>
      )}

      {sessionId && state && !showStudio && (
        <div className="pipeline-stage">
          <PipelineStepper
            currentState={state.state}
            progress={state.progress}
            message={state.message}
            videoUrl={state.videoUrl}
            outputUrl={state.outputUrl}
            onTranscribe={handleTranscribe}
            onRender={handleRender}
          />
          {/* Hidden video to get duration */}
          {state.videoUrl && (
            <video
              src={state.videoUrl}
              style={{ display: "none" }}
              onLoadedMetadata={(e) =>
                handleVideoMetadata(e.currentTarget.duration)
              }
            />
          )}
        </div>
      )}

      {sessionId && state && showStudio && state.videoUrl && (
        <div className="pipeline-stage">
          <StudioView
            videoUrl={state.videoUrl}
            captions={captions}
            durationMs={durationMs}
            onRender={handleRender}
            outputUrl={state.outputUrl}
            isRendering={state.state === "RENDERING"}
          />
        </div>
      )}

      {sessionId && !state && (
        <div className="connecting">Connecting</div>
      )}
    </div>
  );
}

export default App;

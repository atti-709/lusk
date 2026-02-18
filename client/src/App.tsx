import { useState, useCallback } from "react";
import { UploadZone } from "./components/UploadZone";
import { PipelineStepper } from "./components/PipelineStepper";
import { useSSE } from "./hooks/useSSE";
import "./App.css";

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { state } = useSSE(sessionId);

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

      {sessionId && state && (
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
        </div>
      )}

      {sessionId && !state && (
        <div className="connecting">Connecting</div>
      )}
    </div>
  );
}

export default App;

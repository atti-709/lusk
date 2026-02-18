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
      <h1>Lusk</h1>
      <p className="subtitle">Create viral shorts from Slovak video podcasts</p>

      {!sessionId && <UploadZone onUploadComplete={handleUploadComplete} />}

      {sessionId && state && (
        <PipelineStepper
          currentState={state.state}
          progress={state.progress}
          message={state.message}
          outputUrl={state.outputUrl}
          onTranscribe={handleTranscribe}
          onRender={handleRender}
        />
      )}

      {sessionId && !state && <p>Connecting...</p>}
    </div>
  );
}

export default App;

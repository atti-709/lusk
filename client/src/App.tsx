import { useState, useCallback, useEffect } from "react";
import { UploadZone } from "./components/UploadZone";
import { PipelineStepper } from "./components/PipelineStepper";
import { ClipSelector } from "./components/ClipSelector";
import { StudioView } from "./components/StudioView";
import { ResumeDialog } from "./components/ResumeDialog";
import { useSSE } from "./hooks/useSSE";
import type {
  CaptionWord,
  ViralClip,
  SessionSummary,
  ProjectState,
} from "@lusk/shared";
import "./App.css";

type AppView = "loading" | "resume" | "upload" | "session";

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("loading");
  const [existingSessions, setExistingSessions] = useState<SessionSummary[]>(
    []
  );
  const { state } = useSSE(sessionId);
  const [captions, setCaptions] = useState<CaptionWord[]>([]);
  const [viralClips, setViralClips] = useState<ViralClip[]>([]);
  const [selectedClip, setSelectedClip] = useState<ViralClip | null>(null);

  const isReady = state && state.state === "READY";
  const isStudio = selectedClip !== null && isReady;
  const isProcessing =
    state &&
    !["UPLOADING", "READY", "RENDERING", "EXPORTED"].includes(state.state);

  // Check for existing sessions on mount
  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((sessions: SessionSummary[]) => {
        if (sessions.length > 0) {
          setExistingSessions(sessions);
          setView("resume");
        } else {
          setView("upload");
        }
      })
      .catch(() => {
        setView("upload");
      });
  }, []);

  // Fetch project data when reaching READY state
  useEffect(() => {
    if (!sessionId || !isReady) return;

    fetch(`/api/project/${sessionId}`)
      .then((r) => r.json())
      .then((data: ProjectState) => {
        if (data.captions) setCaptions(data.captions);
        if (data.viralClips) setViralClips(data.viralClips);
      })
      .catch(() => {});
  }, [sessionId, isReady]);

  const handleUploadComplete = useCallback((id: string) => {
    setSessionId(id);
    setView("session");
  }, []);

  const handleResume = useCallback((id: string) => {
    setSessionId(id);
    setView("session");
  }, []);

  const handleNew = useCallback(() => {
    setView("upload");
  }, []);

  const handleTranscribe = useCallback(async () => {
    if (!sessionId) return;
    await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }, [sessionId]);

  const handleSelectClip = useCallback((clip: ViralClip) => {
    setSelectedClip(clip);
  }, []);

  const handleBackToClips = useCallback(() => {
    setSelectedClip(null);
  }, []);

  const handleRender = useCallback(
    async (clip: ViralClip) => {
      if (!sessionId) return;
      await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          startMs: clip.startMs,
          endMs: clip.endMs,
        }),
      });
    },
    [sessionId]
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-mark">L</div>
        <h1>Lusk</h1>
      </header>

      {view === "loading" && <div className="connecting">Loading</div>}

      {view === "resume" && (
        <ResumeDialog
          sessions={existingSessions}
          onResume={handleResume}
          onNew={handleNew}
        />
      )}

      {view === "upload" && (
        <div className="upload-hero">
          <p className="tagline">
            Create viral shorts from Slovak video podcasts
          </p>
          <UploadZone onUploadComplete={handleUploadComplete} />
        </div>
      )}

      {/* Pipeline steps (uploading, transcribing, aligning, analyzing) */}
      {view === "session" && sessionId && state && !isReady && (
        <div className="pipeline-stage">
          <PipelineStepper
            currentState={state.state}
            progress={state.progress}
            message={state.message}
            videoUrl={state.videoUrl}
            outputUrl={state.outputUrl}
            onTranscribe={handleTranscribe}
          />
        </div>
      )}

      {/* Clip selection grid */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        state.videoUrl &&
        viralClips.length > 0 && (
          <div className="pipeline-stage">
            <ClipSelector
              clips={viralClips}
              videoUrl={state.videoUrl}
              onSelect={handleSelectClip}
            />
          </div>
        )}

      {/* Studio for selected clip */}
      {view === "session" && isStudio && state.videoUrl && selectedClip && (
        <div className="pipeline-stage">
          <StudioView
            videoUrl={state.videoUrl}
            captions={captions}
            clip={selectedClip}
            onRender={handleRender}
            onBack={handleBackToClips}
            outputUrl={state.outputUrl}
            isRendering={state.state === "RENDERING"}
          />
        </div>
      )}

      {view === "session" && sessionId && !state && (
        <div className="connecting">Connecting</div>
      )}
    </div>
  );
}

export default App;

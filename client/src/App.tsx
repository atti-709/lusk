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
  const [projectLoading, setProjectLoading] = useState(false);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);

  const isReady = state && state.state === "READY";
  const isStudio = selectedClip !== null && !!isReady;

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

  // Fetch project data when reaching READY state and go straight to studio
  useEffect(() => {
    if (!sessionId || !isReady) return;

    setProjectLoading(true);
    fetch(`/api/project/${sessionId}`)
      .then((r) => r.json())
      .then((data: ProjectState) => {
        if (data.captions) setCaptions(data.captions);
        if (data.viralClips) setViralClips(data.viralClips);

        // Auto-navigate to studio with full video
        // Estimate duration from last caption's endMs, or fall back to 10 min
        const lastCaption = data.captions?.at(-1);
        const durationMs = lastCaption ? lastCaption.endMs + 1000 : 600000;
        setSelectedClip({
          title: "Full video",
          hookText: "",
          startMs: 0,
          endMs: durationMs,
        } as ViralClip);
      })
      .catch(() => {})
      .finally(() => setProjectLoading(false));
  }, [sessionId, isReady]);

  const handleUploadComplete = useCallback((id: string) => {
    setSessionId(id);
    setView("session");
  }, []);

  const handleResume = useCallback((id: string) => {
    setSessionId(id);
    setView("session");
  }, []);

  const handleDeleteSession = useCallback((id: string) => {
    fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    setExistingSessions((prev) => {
      const next = prev.filter((s) => s.sessionId !== id);
      if (next.length === 0) setView("upload");
      return next;
    });
  }, []);

  const handleNew = useCallback(() => {
    setView("upload");
  }, []);

  const handleTranscribe = useCallback(async (sourceScript?: string) => {
    if (!sessionId) return;

    // Upload source script if provided (for alignment step)
    if (sourceScript) {
      await fetch(`/api/project/${sessionId}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceScript }),
      });
    }

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
    async (clip: ViralClip, offsetX: number) => {
      if (!sessionId) return;
      await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, clip, offsetX }),
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
          onDelete={handleDeleteSession}
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
            onTranscribe={handleTranscribe}
          />
        </div>
      )}

      {/* Waiting for project data after reaching READY */}
      {view === "session" && isReady && !isStudio && projectLoading && (
        <div className="connecting">Loading clips</div>
      )}

      {/* Clip selection grid */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        !projectLoading &&
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

      {/* Fallback: no clips detected — open full video in studio */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        !projectLoading &&
        state.videoUrl &&
        viralClips.length === 0 && (
          <div className="pipeline-stage">
            <div className="no-clips">
              <p>No viral clips were detected.</p>
              <button
                className="primary"
                onClick={() =>
                  handleSelectClip({
                    title: "Full video",
                    hookText: "",
                    startMs: 0,
                    endMs: (captions.at(-1)?.endMs ?? 0) + 1000 || 600000,
                  } as ViralClip)
                }
              >
                Open in studio
              </button>
            </div>
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

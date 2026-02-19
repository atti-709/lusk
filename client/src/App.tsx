import { useState, useCallback, useEffect, useMemo } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import { UploadZone } from "./components/UploadZone";
import { PipelineStepper, type ReadySubView } from "./components/PipelineStepper";
import { ClipSelector } from "./components/ClipSelector";
import { StudioView } from "./components/StudioView";
import { ResumeDialog } from "./components/ResumeDialog";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "./components/VideoComposition";
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
  const [readySubView, setReadySubView] = useState<ReadySubView>("review");

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

  // Fetch project data when reaching READY state
  useEffect(() => {
    if (!sessionId || !isReady) return;

    setProjectLoading(true);
    fetch(`/api/project/${sessionId}`)
      .then((r) => r.json())
      .then((data: ProjectState) => {
        if (data.captions) setCaptions(data.captions);
        if (data.viralClips) setViralClips(data.viralClips);
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

  const handleBackToAlign = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/project/${sessionId}/back-to-align`, {
      method: "POST",
    });
    if (res.ok) {
      setSelectedClip(null);
      setViralClips([]);
      setReadySubView("review");
    }
  }, [sessionId]);

  const handleStepClick = useCallback(
    (stepId: string) => {
      if (!sessionId || !state) return;

      if (stepId === "ALIGNING") {
        // Go back to align step
        handleBackToAlign();
      } else if (stepId === "REVIEW") {
        if (state.state === "READY") {
          setReadySubView("review");
          setSelectedClip(null);
        }
      } else if (stepId === "CLIPS") {
        if (state.state === "READY") {
          setReadySubView("clips");
          setSelectedClip(null);
        }
      }
    },
    [sessionId, state, handleBackToAlign]
  );

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

  // Full video clip for review player
  const fullVideoClip = useMemo(() => {
    const lastCaption = captions.at(-1);
    const durationMs = lastCaption ? lastCaption.endMs + 1000 : 600000;
    return { startMs: 0, endMs: durationMs };
  }, [captions]);

  // Full video captions for remotion player (review step)
  const fullVideoCaptions: Caption[] = useMemo(
    () =>
      captions.map((c) => ({
        text: c.text,
        startMs: c.startMs,
        endMs: c.endMs,
        timestampMs: c.timestampMs,
        confidence: c.confidence,
      })),
    [captions]
  );

  const fullVideoDurationFrames = Math.max(
    1,
    Math.ceil((fullVideoClip.endMs / 1000) * COMP_FPS)
  );

  // Show step track when in session (both pre-READY and READY states)
  const showStepper = view === "session" && sessionId && state;

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

      {/* Always show stepper when in session */}
      {showStepper && !isStudio && (
        <div className="pipeline-stage">
          <PipelineStepper
            currentState={state.state}
            progress={state.progress}
            message={state.message}
            videoUrl={state.videoUrl}
            sessionId={sessionId}
            readySubView={readySubView}
            onTranscribe={handleTranscribe}
            onStepClick={handleStepClick}
          />
        </div>
      )}

      {/* Review step: full video with captions */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        readySubView === "review" &&
        state.videoUrl &&
        !projectLoading && (
          <div className="pipeline-stage">
            <div className="review-step">
              <h2 className="review-title">Review Captions</h2>
              <p className="review-desc">Preview the full video with captions. Click Next to proceed to clip selection.</p>
              <div className="review-player">
                <Player
                  component={VideoComposition}
                  inputProps={{
                    videoUrl: state.videoUrl,
                    captions: fullVideoCaptions,
                    offsetX: 0,
                    startFrom: 0,
                  }}
                  compositionWidth={COMP_WIDTH}
                  compositionHeight={COMP_HEIGHT}
                  durationInFrames={fullVideoDurationFrames}
                  fps={COMP_FPS}
                  style={{
                    width: "100%",
                    maxHeight: "65vh",
                    borderRadius: 12,
                    overflow: "hidden",
                  }}
                  controls
                  loop
                />
              </div>
              <button
                className="primary"
                onClick={() => setReadySubView("clips")}
              >
                Next → Clip Selection
              </button>
            </div>
          </div>
        )}

      {/* Waiting for project data after reaching READY */}
      {view === "session" && isReady && projectLoading && (
        <div className="connecting">Loading project data</div>
      )}

      {/* Clip selection grid */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        readySubView === "clips" &&
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

      {/* Fallback: no clips detected */}
      {view === "session" &&
        isReady &&
        !isStudio &&
        readySubView === "clips" &&
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
            renders={state.renders ?? {}}
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

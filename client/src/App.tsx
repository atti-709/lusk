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
import { Logo } from "./components/Logo";
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

  // Handle .lusk files opened from Finder (Electron only)
  useEffect(() => {
    const lusk = (window as any).lusk;
    if (!lusk?.onOpenSession) return;
    lusk.onOpenSession((id: string) => {
      setCaptions([]);
      setViralClips([]);
      setSelectedClip(null);
      setReadySubView("review");
      setSessionId(id);
      setView("session");
    });
  }, []);

  // Fetch project data when reaching READY state
  useEffect(() => {
    if (!sessionId || !isReady) return;

    let isMounted = true;
    const fetchProject = async () => {
      setProjectLoading(true);
      try {
        const r = await fetch(`/api/project/${sessionId}`);
        const data: ProjectState = await r.json();
        if (!isMounted) return;
        if (data.captions) setCaptions(data.captions);
        if (data.viralClips) setViralClips(data.viralClips);
      } catch {
        // ignore errors
      } finally {
        if (isMounted) setProjectLoading(false);
      }
    };
    fetchProject();

    return () => { isMounted = false; };
  }, [sessionId, isReady]);

  const handleUploadComplete = useCallback((id: string) => {
    setSessionId(id);
    setView("session");
    // Start transcription automatically
    fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => {});
  }, []);

  // Upload video to an existing IDLE session (imported without video)
  const [idleUploadError, setIdleUploadError] = useState<string | null>(null);
  const handleIdleVideoSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !sessionId) return;
      setIdleUploadError(null);

      const formData = new FormData();
      formData.append("file", file);

      try {
        const response = await fetch(`/api/sessions/${sessionId}/upload-video`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Upload failed" }));
          setIdleUploadError(err.error ?? "Upload failed");
          return;
        }
        // Server verifies duration and transitions straight to READY —
        // SSE will push the new state automatically, no transcription needed.
      } catch {
        setIdleUploadError("Upload failed");
      }
    },
    [sessionId]
  );

  const handleResume = useCallback((id: string) => {
    setCaptions([]);
    setViralClips([]);
    setSelectedClip(null);
    setReadySubView("review");
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

  const [importProgress, setImportProgress] = useState<number | null>(null);

  const handleImport = useCallback((file: File) => {
    setImportProgress(0);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setImportProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        setImportProgress(null);
        // Reset UI state for the new session
        setCaptions([]);
        setViralClips([]);
        setSelectedClip(null);
        setReadySubView("review");
        setSessionId(data.sessionId);
        setView("session");
      } else {
        setImportProgress(null);
      }
    };

    xhr.onerror = () => {
      setImportProgress(null);
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
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

  const handleAddClip = useCallback(async (clip: ViralClip) => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/project/${sessionId}/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clip),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.clips) setViralClips(data.clips);
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

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


  const handleRender = useCallback(
    async (clip: ViralClip, offsetX: number, captions: Caption[]) => {
      if (!sessionId) return;
      await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, clip, offsetX, captions }),
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

  const handleLogoClick = useCallback(() => {
    // If not in session, do nothing or just stay
    if (view === "upload" || view === "loading") return;

    // Fetch latest sessions to decide where to go
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((sessions: SessionSummary[]) => {
        setExistingSessions(sessions);
        if (sessions.length > 0) {
          setView("resume");
        } else {
          setView("upload");
        }
      })
      .catch(() => {
        setView("upload");
      });
      
    // Note: We don't clear sessionId here to allow "resuming" the current active session easily 
    // unless the user picks a different one or deletes it.
  }, [view]);

  return (
    <div className="app">
      <header className="app-header">
        <div 
          className="logo-container" 
          onClick={handleLogoClick}
          role="button"
          tabIndex={0}
          title="Go to Dashboard"
        >
          <div className="logo-mark"><Logo /></div>
          <h1>Lusk</h1>
        </div>
      </header>

      {view === "loading" && <div className="connecting">Loading</div>}

      {view === "resume" && (
        <ResumeDialog
          sessions={existingSessions}
          onResume={handleResume}
          onDelete={handleDeleteSession}
          onNew={handleNew}
          onImport={handleImport}
          importProgress={importProgress}
        />
      )}

      {view === "upload" && (
        <div className="upload-hero">
          <p className="tagline">
            Create viral shorts from Slovak video podcasts
          </p>
          <UploadZone onUploadComplete={handleUploadComplete} onImport={handleImport} importProgress={importProgress} />
        </div>
      )}

      {/* Always show stepper when in session (skip IDLE — has no pipeline steps) */}
      {showStepper && !isStudio && state.state !== "IDLE" && (
        <div className="pipeline-stage">
          <PipelineStepper
            currentState={state.state}
            progress={state.progress}
            message={state.message}
            videoUrl={state.videoUrl}
            sessionId={sessionId}
            readySubView={readySubView}
            onTranscribe={handleTranscribe}
          />
        </div>
      )}

      {/* IDLE state: imported without video — show upload prompt */}
      {view === "session" && state && state.state === "IDLE" && (
        <div className="pipeline-stage">
          <div className="idle-notice">
            <div className="upload-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <h2>Add a source video</h2>
            <p>This project was imported without a video file. Upload one to continue.</p>
            {state.videoName && (
              <p className="idle-filename-hint">
                Looking for: <code>{state.videoName}.mp4</code>
              </p>
            )}
            <label className="primary browse-btn">
              Choose video
              <input
                type="file"
                accept="video/*"
                onChange={handleIdleVideoSelect}
                hidden
              />
            </label>
            {idleUploadError && (
              <p className="idle-error">{idleUploadError}</p>
            )}
          </div>
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
              <div className="review-actions">
                <button
                  className="secondary"
                  onClick={handleBackToAlign}
                >
                  ← Back to Align & Analyze
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    const url = `/api/project/${sessionId}/captions.srt`;
                    const filename = `${state.videoName || "project"}_captions.srt`;

                    if ("showSaveFilePicker" in window) {
                      try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const handle = await (window as any).showSaveFilePicker({
                          suggestedName: filename,
                          types: [{ description: "SRT File", accept: { "application/x-subrip": [".srt"] } }],
                        });
                        const res = await fetch(url);
                        if (!res.ok) return;
                        const blob = await res.blob();
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        return;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      } catch (err: any) {
                        if (err.name === "AbortError") return;
                      }
                    }

                    const a = document.createElement("a");
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }}
                >
                  Download .srt
                </button>
                <button
                  className="primary"
                  onClick={() => setReadySubView("clips")}
                >
                  Next → Clip Selection
                </button>
              </div>
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
        state.videoUrl && (
          <div className="pipeline-stage">
            <ClipSelector
              clips={viralClips}
              videoUrl={state.videoUrl}
              sessionId={sessionId!}
              videoName={state.videoName}
              renders={state.renders ?? {}}
              captions={captions}
              onSelect={handleSelectClip}
              onBack={() => setReadySubView("review")}
              onAddClip={handleAddClip}
            />
          </div>
        )}

      {/* Studio for selected clip */}
      {view === "session" && isStudio && state.videoUrl && selectedClip && (
        <div className="pipeline-stage">
          <StudioView
            key={`clip-${selectedClip.startMs}-${selectedClip.endMs}`}
            videoUrl={state.videoUrl}
            captions={captions}
            clip={selectedClip}
            videoName={state.videoName ?? null}
            onRender={handleRender}
            onBack={handleBackToClips}
            renders={state.renders ?? {}}
            onClipUpdate={(updatedClip) => {
              // Update local state for persistence
              setViralClips((prev) =>
                prev.map((c) => {
                  // Match by reference or ID if available, but here we can match by original start/end?
                  // Actually, since we update the object itself, we need a stable ID. 
                  // Let's assume the clip object reference or title+start/end matches.
                  if (c === selectedClip) return updatedClip;
                   // Fallback: match by title/start/end if object ref doesn't work (e.g. from server refresh)
                  if (
                    c.title === selectedClip.title &&
                    c.startMs === selectedClip.startMs &&
                    c.endMs === selectedClip.endMs
                  ) {
                    return updatedClip;
                  }
                  return c;
                })
              );
              setSelectedClip(updatedClip);
            }}
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

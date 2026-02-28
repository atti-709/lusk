import { useState, useCallback, useEffect, useMemo } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import { Dashboard } from "./components/Dashboard";
import { PipelineStepper, type ReadySubView } from "./components/PipelineStepper";
import { ClipSelector } from "./components/ClipSelector";
import { StudioView } from "./components/StudioView";
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
  ProjectState,
} from "@lusk/shared";
import "./App.css";

type AppView = "loading" | "dashboard" | "session";

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("loading");
  const { state } = useSSE(sessionId);
  const [captions, setCaptions] = useState<CaptionWord[]>([]);
  const [viralClips, setViralClips] = useState<ViralClip[]>([]);
  const [selectedClip, setSelectedClip] = useState<ViralClip | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [readySubView, setReadySubView] = useState<ReadySubView>("review");
  const [whisperxAvailable, setWhisperxAvailable] = useState<boolean>(true);
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [scriptFileName, setScriptFileName] = useState<string | null>(null);

  const isReady = state && state.state === "READY";
  const isStudio = selectedClip !== null && !!isReady;

  // Show dashboard on mount and check whisperx availability
  useEffect(() => {
    setView("dashboard");
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.whisperxAvailable === "boolean") {
          setWhisperxAvailable(data.whisperxAvailable);
        }
      })
      .catch(() => {});
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
        const r = await fetch(`/api/projects/${sessionId}`);
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

  const resetSessionState = useCallback(() => {
    setCaptions([]);
    setViralClips([]);
    setSelectedClip(null);
    setReadySubView("review");
    setScriptText(null);
    setScriptFileName(null);
  }, []);

  const cancelTranscription = useCallback((id: string) => {
    fetch("/api/transcribe/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => {});
  }, []);

  const handleNewProject = useCallback(async () => {
    const lusk = window.lusk;
    if (!lusk) return;

    // Pick save location — video is selected on the next screen
    const saveResult = await lusk.showSaveDialog({
      title: "Save new project as...",
      filters: [{ name: "Lusk Project", extensions: ["lusk"] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return;

    const res = await fetch("/api/projects/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: saveResult.filePath }),
    });

    if (res.ok) {
      const data = await res.json();
      resetSessionState();
      setSessionId(data.projectId);
      setView("session");
    }
  }, [resetSessionState]);

  const handleOpenFile = useCallback(async () => {
    const lusk = window.lusk;
    if (!lusk) return;

    const result = await lusk.showOpenDialog({
      title: "Open project",
      filters: [{ name: "Lusk Project", extensions: ["lusk"] }],
    });
    if (result.canceled || !result.filePath) return;

    const res = await fetch("/api/projects/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: result.filePath }),
    });

    if (res.ok) {
      const data = await res.json();
      resetSessionState();
      setSessionId(data.projectId);
      setView("session");
    }
  }, [resetSessionState]);

  const handleOpenProject = useCallback(async (projectId: string, projectPath: string) => {
    // Confirm before aborting any in-progress transcription
    if (sessionId && state?.state === "TRANSCRIBING") {
      if (!window.confirm("Transcription is in progress. Navigate away and stop it?")) return;
      cancelTranscription(sessionId);
    }
    resetSessionState();

    // Ensure the server has the session loaded (it may have restarted)
    let projectState: string | null = null;
    try {
      const res = await fetch("/api/projects/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath }),
      });
      if (!res.ok) {
        console.error("Failed to open project on server");
        return;
      }
      const data = await res.json();
      projectState = data.state ?? null;
    } catch {
      console.error("Failed to reach server");
      return;
    }

    setSessionId(projectId);
    setView("session");

    // Auto-restart transcription if the project has a video but hasn't been transcribed yet
    if (projectState === "UPLOADING" && whisperxAvailable) {
      fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: projectId }),
      }).catch(() => {});
    }
  }, [sessionId, state?.state, cancelTranscription, resetSessionState]);

  // Upload video to an existing IDLE session
  const [idleUploadError, setIdleUploadError] = useState<string | null>(null);
  const [idleDragOver, setIdleDragOver] = useState(false);

  const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

  const selectVideoForProject = useCallback(async (videoPath: string) => {
    if (!sessionId) return;
    setIdleUploadError(null);
    try {
      const response = await fetch(`/api/projects/${sessionId}/select-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Failed to select video" }));
        setIdleUploadError(err.error ?? "Failed to select video");
      }
    } catch {
      setIdleUploadError("Failed to select video");
    }
  }, [sessionId]);

  const handleIdleVideoSelect = useCallback(async () => {
    const lusk = window.lusk;
    if (!lusk) return;
    const result = await lusk.showOpenDialog({
      title: "Select video file",
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (result.canceled || !result.filePath) return;
    selectVideoForProject(result.filePath);
  }, [selectVideoForProject]);

  const handleIdleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIdleDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.lusk?.getFilePath?.(file) ?? "";
    if (!filePath) {
      setIdleUploadError("Drag & drop requires the desktop app");
      return;
    }
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      setIdleUploadError(`Unsupported format. Use: ${VIDEO_EXTENSIONS.join(", ")}`);
      return;
    }
    selectVideoForProject(filePath);
  }, [selectVideoForProject]);

  const handleScriptFile = useCallback(async (filePath: string) => {
    if (!sessionId) return;
    const fileName = filePath.split("/").pop() ?? filePath;
    try {
      const content = await window.lusk?.readFile?.(filePath);
      if (!content) {
        setIdleUploadError("Could not read script file");
        return;
      }
      const res = await fetch(`/api/projects/${sessionId}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptText: content }),
      });
      if (res.ok) {
        setScriptText(content);
        setScriptFileName(fileName);
      }
    } catch {
      setIdleUploadError("Failed to upload script");
    }
  }, [sessionId]);

  const handleScriptDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.lusk?.getFilePath?.(file) ?? "";
    if (filePath) {
      handleScriptFile(filePath);
    } else {
      // Browser fallback: read via FileReader
      const reader = new FileReader();
      reader.onload = async () => {
        const content = reader.result as string;
        if (!sessionId) return;
        const res = await fetch(`/api/projects/${sessionId}/script`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptText: content }),
        });
        if (res.ok) {
          setScriptText(content);
          setScriptFileName(file.name);
        }
      };
      reader.readAsText(file);
    }
  }, [sessionId, handleScriptFile]);

  const handleScriptBrowse = useCallback(async () => {
    const lusk = window.lusk;
    if (!lusk) return;
    const result = await lusk.showOpenDialog({
      title: "Select reference script",
      filters: [{ name: "Markdown", extensions: ["md", "txt"] }],
    });
    if (result.canceled || !result.filePath) return;
    handleScriptFile(result.filePath);
  }, [handleScriptFile]);

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
      const res = await fetch(`/api/projects/${sessionId}/clips`, {
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
    const res = await fetch(`/api/projects/${sessionId}/back-to-align`, {
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
    if (view === "dashboard" || view === "loading") return;
    if (sessionId && state?.state === "TRANSCRIBING") {
      if (!window.confirm("Transcription is in progress. Navigate away and stop it?")) return;
      cancelTranscription(sessionId);
    }
    setSessionId(null);
    resetSessionState();
    setView("dashboard");
  }, [view, sessionId, state?.state, cancelTranscription, resetSessionState]);

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

      {view === "dashboard" && (
        <Dashboard
          onOpenProject={handleOpenProject}
          onNewProject={handleNewProject}
          onOpenFile={handleOpenFile}
          whisperxAvailable={whisperxAvailable}
        />
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
            whisperxAvailable={whisperxAvailable}
          />
        </div>
      )}

      {/* IDLE state: no video linked yet — show drop zone */}
      {view === "session" && state && state.state === "IDLE" && (
        <div className="pipeline-stage">
          <div
            className={`idle-notice idle-dropzone${idleDragOver ? " drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIdleDragOver(true); }}
            onDragLeave={() => setIdleDragOver(false)}
            onDrop={handleIdleDrop}
          >
            <div className="upload-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <h2>Add a source video</h2>
            <p>Drag & drop a video file here, or click to browse.</p>
            {state.videoName && (
              <p className="idle-filename-hint">
                Looking for: <code>{state.videoName}.mp4</code>
              </p>
            )}
            <button className="primary" onClick={handleIdleVideoSelect}>
              Browse files
            </button>
          </div>

          {/* Script drop zone */}
          <div
            className="idle-notice idle-dropzone script-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleScriptDrop}
          >
            <div className="upload-icon">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <h2>Add reference script <span className="optional-badge">optional</span></h2>
            {scriptFileName ? (
              <p className="script-loaded">{scriptFileName}</p>
            ) : (
              <p>Drag & drop a .md script for AI-powered transcript correction.</p>
            )}
            <button className="secondary" onClick={handleScriptBrowse}>
              Browse scripts
            </button>
          </div>

          {idleUploadError && (
            <p className="idle-error">{idleUploadError}</p>
          )}
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
                    const url = `/api/projects/${sessionId}/captions.srt`;
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

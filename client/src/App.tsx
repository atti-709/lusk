import { useState, useCallback, useEffect, useMemo } from "react";
import { Player } from "@remotion/player";
import type { Caption } from "@remotion/captions";
import { Dashboard } from "./components/Dashboard";
import { PipelineStepper, type ReadySubView } from "./components/PipelineStepper";
import { ClipSelector } from "./components/ClipSelector";
import { StudioView } from "./components/StudioView";
import { useCancelPrompt } from "./contexts/CancelPromptContext";
import { useAppSettings } from "./contexts/AppSettingsContext";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
} from "./components/VideoComposition";
import { Logo } from "./components/Logo";
import { SettingsDialog } from "./components/SettingsDialog";
import { UpdateOverlay } from "./components/UpdateOverlay";
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
  const { fps } = useAppSettings();
  const { state } = useSSE(sessionId);
  const [captions, setCaptions] = useState<CaptionWord[]>([]);
  const [viralClips, setViralClips] = useState<ViralClip[]>([]);
  const [selectedClip, setSelectedClip] = useState<ViralClip | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [readySubView, setReadySubView] = useState<ReadySubView>("review");
  const [whisperxAvailable, setWhisperxAvailable] = useState<boolean>(true);
  const [geminiAvailable, setGeminiAvailable] = useState<boolean>(false);
  const [scriptFileName, setScriptFileName] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logoPopupOpen, setLogoPopupOpen] = useState(false);
  const [pendingVideoPath, setPendingVideoPath] = useState<string | null>(null);

  const VIDEO_EXTENSIONS = useMemo(() => ["mp4", "mov", "mkv", "avi", "webm"], []);

  const isReady = state && state.state === "READY";
  const isStudio = selectedClip !== null && !!isReady;

  // A process is "working" if the backend is actively munching on something
  const isWorking = !!state &&
    ["TRANSCRIBING", "ALIGNING", "RENDERING"].includes(state.state);

  const sourceAspectRatio = useMemo(() => {
    if (!state?.videoWidth || !state?.videoHeight) return null;
    return state.videoWidth / state.videoHeight;
  }, [state?.videoWidth, state?.videoHeight]);

  // Show dashboard on mount and check whisperx availability
  useEffect(() => {
    setView("dashboard");
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.whisperxAvailable === "boolean") {
          setWhisperxAvailable(data.whisperxAvailable);
        }
        if (typeof data.geminiApiKeySet === "boolean") {
          setGeminiAvailable(data.geminiApiKeySet);
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

  // Sync captions and viral clips from SSE state whenever it updates to READY.
  // The SSE payload already contains the full project data, so we can read
  // directly from it — no separate fetch needed, avoiding race conditions.
  useEffect(() => {
    if (!state || state.state !== "READY") return;
    if (state.captions) setCaptions(state.captions);
    if (state.viralClips) setViralClips(state.viralClips);
    setProjectLoading(false);
  }, [state]);

  // Fetch whisper captions when entering ALIGNING state (for preview during alignment)
  useEffect(() => {
    if (!sessionId || state?.state !== "ALIGNING" || captions.length > 0) return;

    let isMounted = true;
    fetch(`/api/projects/${sessionId}`)
      .then((r) => r.json())
      .then((data: ProjectState) => {
        if (!isMounted || !data.captions) return;
        setCaptions(data.captions);
      })
      .catch(() => {});

    return () => { isMounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, state?.state]);

  const resetSessionState = useCallback(() => {
    setCaptions([]);
    setViralClips([]);
    setSelectedClip(null);
    setReadySubView("review");
    setScriptFileName(null);
    setPendingVideoPath(null);
  }, []);

  const cancelPrompt = useCancelPrompt();
  const cancelProject = useCallback((id: string) => {
    fetch(`/api/projects/${id}/cancel`, { method: "POST" }).catch(() => {});
  }, []);

  // Register working process as cancellable for Cmd+R (transcription, alignment, render)
  useEffect(() => {
    if (!cancelPrompt || !sessionId || !isWorking) return;
    const label = state?.state === "TRANSCRIBING" ? "transcription"
      : state?.state === "ALIGNING" ? "alignment"
      : "render";
    cancelPrompt.register({
      id: "project-work",
      label,
      onCancel: () => cancelProject(sessionId),
    });
    return () => cancelPrompt.unregister("project-work");
  }, [cancelPrompt, sessionId, isWorking, state?.state, cancelProject]);

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

    if (isWorking) {
      if (!window.confirm("A process is running. Opening a project will cancel it. Continue?")) return;
      if (sessionId) cancelProject(sessionId);
    }

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
  }, [resetSessionState, isWorking, cancelProject, sessionId]);

  const handleOpenProject = useCallback(async (projectId: string, projectPath: string) => {
    // Confirm before aborting any in-progress transcription
    if (sessionId && isWorking) {
      if (!window.confirm("A process is running. Navigate away and stop it?")) return;
      cancelProject(sessionId);
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
  }, [sessionId, isWorking, cancelProject, resetSessionState, whisperxAvailable]);

  // Upload video to an existing IDLE session
  const [idleUploadError, setIdleUploadError] = useState<string | null>(null);
  const [idleDragOver, setIdleDragOver] = useState(false);
  const [scriptDragOver, setScriptDragOver] = useState(false);

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
    setIdleUploadError(null);
    setPendingVideoPath(result.filePath);
  }, [VIDEO_EXTENSIONS]);

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
    setIdleUploadError(null);
    setPendingVideoPath(filePath);
  }, [VIDEO_EXTENSIONS]);

  const handleIdleNext = useCallback(async () => {
    if (!pendingVideoPath || !sessionId) return;
    await selectVideoForProject(pendingVideoPath);
    fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }, [pendingVideoPath, sessionId, selectVideoForProject]);

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

  const handleSelectClip = useCallback((clip: ViralClip) => {
    setSelectedClip(clip);
    // Sync render states to clear any stuck "rendering" entries from cancelled renders
    if (sessionId) {
      fetch(`/api/projects/${sessionId}/sync-render-states`, { method: "POST" }).catch(() => {});
    }
  }, [sessionId]);

  const handleBackToClips = useCallback(() => {
    const hasRendering = state?.renders && Object.values(state.renders).some((r) => r.status === "rendering");
    if (hasRendering && !window.confirm("A video is rendering. Go back and cancel it?")) return;
    if (sessionId && hasRendering) {
      fetch(`/api/projects/${sessionId}/cancel-render`, { method: "POST" }).catch(() => {});
    }
    setSelectedClip(null);
  }, [sessionId, state?.renders]);

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
    Math.ceil((fullVideoClip.endMs / 1000) * fps)
  );

  // Memoize inputProps and style to prevent Remotion Player from resetting
  // its internal animation state on parent re-renders.
  const reviewPlayerInputProps = useMemo(
    () => ({
      videoUrl: state?.videoUrl ?? "",
      captions: fullVideoCaptions,
      offsetX: 0,
      startFrom: 0,
      sourceAspectRatio,
    }),
    [state?.videoUrl, fullVideoCaptions, sourceAspectRatio]
  );

  const reviewPlayerStyle = useMemo(() => ({ width: "100%" as const }), []);

  // Show step track when in session (both pre-READY and READY states)
  const showStepper = view === "session" && sessionId && state;

  const handleLogoClick = useCallback(() => {
    if (view === "dashboard" || view === "loading") return;
    setLogoPopupOpen(true);
  }, [view]);

  const handleLogoPopupConfirm = useCallback(() => {
    setLogoPopupOpen(false);
    if (sessionId) {
      if (isWorking) cancelProject(sessionId);
      if (state?.renders && Object.values(state.renders).some((r) => r.status === "rendering")) {
        fetch(`/api/projects/${sessionId}/cancel-render`, { method: "POST" }).catch(() => {});
      }
    }
    setSessionId(null);
    resetSessionState();
    setView("dashboard");
  }, [sessionId, isWorking, state?.renders, cancelProject, resetSessionState]);

  const handleLogoPopupDismiss = useCallback(() => {
    setLogoPopupOpen(false);
  }, []);

  // Intercept Cmd+R to show the same guard as the logo click instead of reloading
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "r") {
        e.preventDefault();
        if (isWorking) {
          if (window.confirm("A process is running. Reloading will stop it. Continue?")) {
            if (sessionId) cancelProject(sessionId);
            // Allow a tiny bit of time for the cancel request to fire before the page unloads
            setTimeout(() => window.location.reload(), 50);
          }
        } else {
          if (window.confirm("Reload the app?")) {
            window.location.reload();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isWorking, sessionId, cancelProject]);
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isWorking) {
        e.preventDefault();
        e.returnValue = ""; // required for browser prompt
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isWorking]);

  return (
    <div className="app">
      <UpdateOverlay />
      <header className="app-header">
        <div className="header-side" />
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
        <div className="header-side header-actions">
          <button
            className="settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onKeySet={setGeminiAvailable} />

      {logoPopupOpen && (
        <div
          className="cancel-prompt-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logo-popup-title"
        >
          <div className="cancel-prompt">
            <h3 id="logo-popup-title">
              {isWorking ? "A process is running" : "Go to Dashboard?"}
            </h3>
            <p className="cancel-prompt-desc">
              {isWorking
                ? "Navigate away and stop the current operation?"
                : "Leave this project and return to the dashboard?"}
            </p>
            <div className="cancel-prompt-actions">
              <button className="secondary" onClick={handleLogoPopupDismiss}>
                Stay
              </button>
              <button className="primary" onClick={handleLogoPopupConfirm}>
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      )}

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
            whisperxAvailable={whisperxAvailable}
            geminiAvailable={geminiAvailable}
            captions={captions}
            sourceAspectRatio={sourceAspectRatio}
            videoDurationMs={state.videoDurationMs}
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
            {pendingVideoPath ? (
              <p className="script-loaded">{pendingVideoPath.split("/").pop()}</p>
            ) : (
              <p>Drag & drop a video file here, or click to browse.</p>
            )}
            {state.videoName && !pendingVideoPath && (
              <p className="idle-filename-hint">
                Looking for: <code>{state.videoName}.mp4</code>
              </p>
            )}
            <button className="secondary" onClick={handleIdleVideoSelect}>
              Browse files
            </button>
          </div>

          {/* Script drop zone */}
          <div
            className={`idle-notice idle-dropzone script-dropzone${scriptDragOver ? " drag-over" : ""}${!geminiAvailable ? " disabled" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (geminiAvailable) setScriptDragOver(true); }}
            onDragLeave={() => setScriptDragOver(false)}
            onDrop={(e) => { setScriptDragOver(false); if (geminiAvailable) handleScriptDrop(e); }}
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
            {!geminiAvailable ? (
              <p className="settings-hint">Requires Gemini API key — configure in <button className="inline-link" onClick={() => setSettingsOpen(true)}>Settings</button></p>
            ) : scriptFileName ? (
              <p className="script-loaded">{scriptFileName}</p>
            ) : (
              <p>Drag & drop a .md script for AI-powered transcript correction.</p>
            )}
            <button className="secondary" onClick={handleScriptBrowse} disabled={!geminiAvailable}>
              Browse scripts
            </button>
          </div>

          {idleUploadError && (
            <p className="idle-error">{idleUploadError}</p>
          )}

          {pendingVideoPath && (
            <div className="idle-next-row">
              <button className="primary" onClick={handleIdleNext}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8 19 13" /><path d="M15 9h.01" /><path d="M17.8 6.2 19 5" /><path d="m3 21 9-9" /><path d="M12.2 6.2 11 5" />
                </svg>
                Start
              </button>
            </div>
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
                  inputProps={reviewPlayerInputProps}
                  compositionWidth={COMP_WIDTH}
                  compositionHeight={COMP_HEIGHT}
                  durationInFrames={fullVideoDurationFrames}
                  fps={fps}
                  style={reviewPlayerStyle}
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
                    const projectName =
                      state.videoName?.trim() ||
                      (state.projectFilePath
                        ? state.projectFilePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.lusk$/i, "").trim() || "project"
                        : "project");

                    const urls = [`/api/projects/${sessionId}/captions.srt`];
                    if (state.translatedCaptions && state.translatedCaptions.length > 0) {
                      urls.push(`/api/projects/${sessionId}/captions-en.srt`);
                    }

                    for (const url of urls) {
                      const res = await fetch(url);
                      if (!res.ok) continue;
                      // Extract server-provided filename (e.g. captions_sk.srt)
                      const disposition = res.headers.get("Content-Disposition") ?? "";
                      const match = disposition.match(/filename="(.+?)"/);
                      const serverName = match?.[1] ?? "captions.srt";
                      const filename = `${projectName}_${serverName}`;

                      const blob = await res.blob();

                      if ("showSaveFilePicker" in window) {
                        try {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const handle = await (window as any).showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description: "SRT File", accept: { "application/x-subrip": [".srt"] } }],
                          });
                          const writable = await handle.createWritable();
                          await writable.write(blob);
                          await writable.close();
                          continue;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        } catch (err: any) {
                          if (err.name === "AbortError") return;
                        }
                      }

                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = filename;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(a.href);
                    }
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
            sourceAspectRatio={sourceAspectRatio}
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

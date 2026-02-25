import { useRef, useEffect, useState, useCallback, type FormEvent } from "react";
import type { ViralClip, ClipRenderState, CaptionWord } from "@lusk/shared";
import type { Caption } from "@remotion/captions";
import "./ClipSelector.css";

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseTimeToMs(value: string): number | null {
  const trimmed = value.trim();
  // Accept M:SS, MM:SS, H:MM:SS, or HH:MM:SS
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(s) || m < 0 || s < 0 || s >= 60) return null;
    return Math.round((m * 60 + s) * 1000);
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s) || h < 0 || m < 0 || m >= 60 || s < 0 || s >= 60) return null;
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  return null;
}

function ClipCard({
  clip,
  videoUrl,
  disabled,
  onClick,
}: {
  clip: ViralClip;
  videoUrl: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clip.startMs / 1000;
  }, [clip.startMs]);

  const durationSec = Math.round((clip.endMs - clip.startMs) / 1000);

  return (
    <button
      className="clip-card"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
    >
      <div className="clip-card-preview">
        <video
          ref={videoRef}
          src={`${videoUrl}#t=${clip.startMs / 1000}`}
          muted
          playsInline
          preload="metadata"
        />
        <span className="clip-card-duration">{durationSec}s</span>
      </div>
      <div className="clip-card-body">
        <div className="clip-card-title">{clip.title}</div>
        <div className="clip-card-hook">"{clip.hookText}"</div>
        <div className="clip-card-time">
          {formatMs(clip.startMs)} — {formatMs(clip.endMs)}
        </div>
      </div>
    </button>
  );
}

function AddClipForm({ onAdd, onCancel }: { onAdd: (clip: ViralClip) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [hookText, setHookText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const startRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    startRef.current?.focus();
  }, []);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const startMs = parseTimeToMs(startTime);
    const endMs = parseTimeToMs(endTime);

    if (startMs === null) {
      setError("Invalid start time. Use M:SS or H:MM:SS format.");
      return;
    }
    if (endMs === null) {
      setError("Invalid end time. Use M:SS or H:MM:SS format.");
      return;
    }
    if (endMs <= startMs) {
      setError("End time must be after start time.");
      return;
    }

    onAdd({
      title: title.trim() || "Custom Clip",
      startMs,
      endMs,
      hookText: hookText.trim(),
    });
  }, [title, startTime, endTime, hookText, onAdd]);

  return (
    <form className="add-clip-form" onSubmit={handleSubmit}>
      <div className="add-clip-form-row">
        <label>
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Custom Clip"
          />
        </label>
      </div>
      <div className="add-clip-form-row add-clip-form-times">
        <label>
          Start
          <input
            ref={startRef}
            type="text"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            placeholder="0:00"
            required
          />
        </label>
        <label>
          End
          <input
            type="text"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            placeholder="1:30"
            required
          />
        </label>
      </div>
      <div className="add-clip-form-row">
        <label>
          Hook text <span className="optional">(optional)</span>
          <input
            type="text"
            value={hookText}
            onChange={(e) => setHookText(e.target.value)}
            placeholder="Opening line..."
          />
        </label>
      </div>
      {error && <p className="add-clip-form-error">{error}</p>}
      <div className="add-clip-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary">Add Clip</button>
      </div>
    </form>
  );
}

async function streamExport(
  sessionId: string,
  videoName: string | null,
  includeVideo: boolean,
  onProgress: (pct: number) => void,
) {
  const fileName = `${videoName || "project"}.lusk`;
  const url = `/api/project/${sessionId}/export?includeVideo=${includeVideo}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error("Export failed");

  const contentLength = Number(response.headers.get("Content-Length") || 0);
  const reader = response.body!.getReader();

  // Try File System Access API first
  let writableStream: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closeWritable: (() => Promise<void>) | null = null;
  let blobChunks: Uint8Array[] | null = null;

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: "Lusk Project",
          accept: { "application/zip": [".lusk"] },
        }],
      });
      const writable = await handle.createWritable();
      writableStream = writable.getWriter();
      closeWritable = async () => {
        writableStream!.releaseLock();
        await writable.close();
      };
    } catch (err: any) {
      if (err.name === "AbortError") return;
    }
  }

  if (!writableStream) {
    blobChunks = [];
  }

  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (contentLength > 0) {
      onProgress(Math.min(99, Math.round((received / contentLength) * 100)));
    }
    if (writableStream) {
      await writableStream.write(value);
    } else {
      blobChunks!.push(value);
    }
  }

  if (writableStream && closeWritable) {
    await closeWritable();
  } else if (blobChunks) {
    const blob = new Blob(blobChunks, { type: "application/zip" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }

  onProgress(100);
}

// ── Batch render helpers ─────────────────────────────────────────────────

const CAPTION_DELAY_MS_BATCH = 900; // matches StudioView's CAPTION_DELAY_MS
const COMP_FPS_BATCH = 23.976;      // matches VideoComposition's COMP_FPS

/** Compute Remotion-format captions for a clip, applying stored edits and offset. */
function buildRemotionCaptions(clip: ViralClip, allCaptions: CaptionWord[]): Caption[] {
  const trimStartDelta = clip.trimStartDelta ?? 0;
  const trimEndDelta = clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH;
  const captionOffset = clip.captionOffset ?? 0;
  const captionEdits = clip.captionEdits ?? {};

  const effectiveStartMs = clip.startMs + trimStartDelta;
  const effectiveEndMs = clip.endMs + trimEndDelta;

  // Frame-align the start (matches RenderService logic)
  const startFrame = Math.round((effectiveStartMs / 1000) * COMP_FPS_BATCH);
  const actualStartMs = (startFrame / COMP_FPS_BATCH) * 1000;

  return allCaptions
    .map((c, globalIndex) => ({ c, globalIndex }))
    .filter(({ c }) => c.endMs > effectiveStartMs && c.startMs < effectiveEndMs)
    .map(({ c, globalIndex }) => ({
      text: captionEdits[globalIndex] ?? c.text,
      startMs: c.startMs - actualStartMs + captionOffset,
      endMs: c.endMs - actualStartMs + captionOffset,
      timestampMs: c.timestampMs != null ? c.timestampMs - actualStartMs + captionOffset : null,
      confidence: c.confidence,
    }));
}

/** Build the trimmed clip object sent to /api/render. */
function buildTrimmedClip(clip: ViralClip): ViralClip {
  const trimStartDelta = clip.trimStartDelta ?? 0;
  const trimEndDelta = clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH;
  return {
    ...clip,
    startMs: clip.startMs + trimStartDelta,
    endMs: clip.endMs + trimEndDelta,
  };
}

/** Compute the render key for a clip (effective trimmed start-end). */
function clipRenderKey(clip: ViralClip): string {
  const effectiveStart = clip.startMs + (clip.trimStartDelta ?? 0);
  const effectiveEnd = clip.endMs + (clip.trimEndDelta ?? CAPTION_DELAY_MS_BATCH);
  return `${effectiveStart}-${effectiveEnd}`;
}

/** Stream the clips-zip from server to a file handle or trigger a blob download. */
async function downloadClipsZip(
  sessionId: string,
  fileHandle: FileSystemFileHandle | null,
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/clips-zip`);
  if (!response.ok) throw new Error("ZIP download failed");

  const reader = response.body!.getReader();

  let writableStream: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closeWritable: (() => Promise<void>) | null = null;
  let blobChunks: Uint8Array[] | null = null;

  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    writableStream = writable.getWriter();
    closeWritable = async () => {
      writableStream!.releaseLock();
      await writable.close();
    };
  } else {
    blobChunks = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (writableStream) await writableStream.write(value);
    else blobChunks!.push(value);
  }

  if (writableStream && closeWritable) {
    await closeWritable();
  } else if (blobChunks) {
    const blob = new Blob(blobChunks as BlobPart[], { type: "application/zip" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "clips.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }
}

interface ClipSelectorProps {
  clips: ViralClip[];
  videoUrl: string;
  sessionId: string;
  videoName: string | null;
  renders: Record<string, ClipRenderState>;
  captions: CaptionWord[];
  onSelect: (clip: ViralClip) => void;
  onBack: () => void;
  onAddClip: (clip: ViralClip) => void;
}

export function ClipSelector({ clips, videoUrl, sessionId, videoName, renders, captions, onSelect, onBack, onAddClip }: ClipSelectorProps) {
  const [showForm, setShowForm] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const isExporting = exportProgress !== null && exportProgress < 100;

  // ── Batch render state ─────────────────────────────────────────────────
  type BatchState = "idle" | "rendering" | "zipping" | "done";
  const [batchState, setBatchState] = useState<BatchState>("idle");
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Mutable batch control — not state to avoid stale closures
  const batchRef = useRef<{
    queue: ViralClip[];
    index: number;
    fileHandle: FileSystemFileHandle | null;
    currentKey: string | null;
    currentWasRendering: boolean;
  } | null>(null);

  // Close export menu when clicking outside (but not during export)
  useEffect(() => {
    if (!showExportMenu || isExporting) return;
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showExportMenu, isExporting]);

  // Auto-hide dropdown after export completes
  useEffect(() => {
    if (exportProgress !== 100) return;
    const t = setTimeout(() => {
      setShowExportMenu(false);
      setExportProgress(null);
    }, 1500);
    return () => clearTimeout(t);
  }, [exportProgress]);

  // Advance the batch queue whenever renders state changes
  useEffect(() => {
    const batch = batchRef.current;
    if (!batch || !batch.currentKey || batchState !== "rendering") return;

    const key = batch.currentKey;
    const renderState = renders[key];

    if (renderState?.status === "rendering") {
      batch.currentWasRendering = true;
      return;
    }

    const finished = renderState?.status === "exported";
    const failed = !renderState && batch.currentWasRendering;
    if (!finished && !failed) return;

    // Advance to next clip
    batch.index++;
    setBatchDone(batch.index);

    if (batch.index >= batch.queue.length) {
      // All clips done — download zip
      batch.currentKey = null;
      const handle = batch.fileHandle;
      batchRef.current = null;
      setBatchState("zipping");
      downloadClipsZip(sessionId, handle)
        .then(() => {
          setBatchState("done");
          setTimeout(() => setBatchState("idle"), 2000);
        })
        .catch((e: Error) => {
          setBatchError(e.message);
          setBatchState("idle");
        });
      return;
    }

    // Trigger next clip render
    const nextClip = batch.queue[batch.index];
    batch.currentKey = clipRenderKey(nextClip);
    batch.currentWasRendering = false;

    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        clip: buildTrimmedClip(nextClip),
        offsetX: nextClip.speakerOffsetX ?? 0,
        captions: buildRemotionCaptions(nextClip, captions),
      }),
    }).then((res) => {
      if (res.status === 409) {
        // Already rendering — mark so the watcher detects when it clears
        if (batchRef.current) batchRef.current.currentWasRendering = true;
      }
    }).catch(() => {/* network error — watcher will time out and advance */});
  }, [renders, batchState, sessionId, captions]);

  const handleRenderAll = useCallback(async () => {
    setBatchError(null);
    setShowExportMenu(false); // close export dropdown if open (native dialog won't fire outside-click)

    // Ask the server to validate exported render files — clears any whose
    // .mp4 was deleted while the server was running — and return the fresh map.
    let freshRenders: Record<string, { status: string }> = { ...renders };
    try {
      const syncRes = await fetch(
        `/api/sessions/${sessionId}/sync-render-states`,
        { method: "POST" }
      );
      if (syncRes.ok) {
        const json = await syncRes.json() as { renders: Record<string, { status: string }> };
        freshRenders = json.renders;
      }
    } catch {
      // Network error — fall back to current SSE state
    }

    // Build queue: clips not yet exported (using server-validated state)
    const pending = clips.filter(
      (clip) => freshRenders[clipRenderKey(clip)]?.status !== "exported"
    );

    // Prompt for save destination before any rendering starts
    let fileHandle: FileSystemFileHandle | null = null;
    if ("showSaveFilePicker" in window) {
      try {
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: "clips.zip",
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (err: any) {
        if (err.name === "AbortError") return; // User cancelled — abort
      }
    }

    if (pending.length === 0) {
      // All clips already rendered — just zip them
      setBatchState("zipping");
      setBatchTotal(clips.length);
      setBatchDone(clips.length);
      downloadClipsZip(sessionId, fileHandle)
        .then(() => {
          setBatchState("done");
          setTimeout(() => setBatchState("idle"), 2000);
        })
        .catch((e: Error) => {
          setBatchError(e.message);
          setBatchState("idle");
        });
      return;
    }

    // Start batch
    const firstClip = pending[0];

    batchRef.current = {
      queue: pending,
      index: 0,
      fileHandle,
      currentKey: clipRenderKey(firstClip),
      currentWasRendering: false,
    };

    setBatchTotal(pending.length);
    setBatchDone(0);
    setBatchState("rendering");

    // Fire first render
    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        clip: buildTrimmedClip(firstClip),
        offsetX: firstClip.speakerOffsetX ?? 0,
        captions: buildRemotionCaptions(firstClip, captions),
      }),
    }).then((res) => {
      if (res.status === 409) {
        // Clip already rendering — mark so the watcher detects when it clears
        if (batchRef.current) batchRef.current.currentWasRendering = true;
      }
    }).catch(() => {/* network error ignored — watcher handles stall */});
  }, [clips, renders, sessionId, captions]);

  const handleAdd = useCallback((clip: ViralClip) => {
    onAddClip(clip);
    setShowForm(false);
  }, [onAddClip]);

  const startExport = useCallback(() => {
    setExportProgress(0);
    streamExport(sessionId, videoName, includeVideo, setExportProgress)
      .catch(() => {
        setExportProgress(null);
      });
  }, [sessionId, videoName, includeVideo]);

  return (
    <div className="clip-selector">
      <div className="clip-selector-header">
        <button className="secondary studio-back" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Review
        </button>
        <div className="clip-selector-title-group">
          <h2>Pick a clip to edit</h2>
          <p className="subtitle">
            {clips.length} clip{clips.length !== 1 ? "s" : ""}
          </p>
        </div>
        {clips.length > 0 && (
          <div className="render-all-wrapper">
            <button
              className="render-all-btn"
              onClick={handleRenderAll}
              disabled={batchState === "rendering" || batchState === "zipping"}
              title={batchError ?? undefined}
            >
              {/* Film strip + download icon */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <line x1="2" y1="7" x2="7" y2="7" />
                <line x1="2" y1="17" x2="7" y2="17" />
                <line x1="17" y1="17" x2="22" y2="17" />
                <line x1="17" y1="7" x2="22" y2="7" />
              </svg>
              {batchState === "done" ? "Done!" : "Render All"}
              {batchState === "idle" && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
            </button>
            {batchError && <p className="render-all-error">{batchError}</p>}
          </div>
        )}
        <div className="export-wrapper" ref={exportRef}>
          <button
            className="secondary export-trigger-btn"
            onClick={() => setShowExportMenu((v) => !v)}
          >
            {/* Package/box icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            Export
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showExportMenu && (
            <div className="export-dropdown">
              {isExporting ? (
                <>
                  <div className="export-progress-header">
                    <span>Exporting...</span>
                    <span className="export-progress-pct">{exportProgress}%</span>
                  </div>
                  <div className="export-progress-track">
                    <div
                      className="export-progress-fill"
                      style={{ width: `${exportProgress}%` }}
                    />
                  </div>
                </>
              ) : exportProgress === 100 ? (
                <div className="export-done">Done!</div>
              ) : (
                <>
                  <label className="export-checkbox">
                    <input
                      type="checkbox"
                      checked={includeVideo}
                      onChange={(e) => setIncludeVideo(e.target.checked)}
                    />
                    Include source video
                  </label>
                  <button
                    className="primary export-confirm"
                    onClick={startExport}
                  >
                    Export
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="clip-grid">
        {clips.map((clip, i) => (
          <ClipCard
            key={i}
            clip={clip}
            videoUrl={videoUrl}
            disabled={batchState === "rendering" || batchState === "zipping"}
            onClick={() => onSelect(clip)}
          />
        ))}
        {showForm ? (
          <AddClipForm onAdd={handleAdd} onCancel={() => setShowForm(false)} />
        ) : (
          <button className="clip-card clip-card-add" onClick={() => setShowForm(true)}>
            <div className="clip-card-add-content">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Add Clip</span>
            </div>
          </button>
        )}
      </div>

      {/* Batch render progress modal */}
      {(batchState === "rendering" || batchState === "zipping" || batchState === "done") && (
        <div className="batch-modal-overlay">
          <div className="batch-modal">
            <div className={`batch-modal-icon ${batchState === "done" ? "done" : "spinning"}`}>
              {batchState === "done" ? (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              )}
            </div>

            <h3 className="batch-modal-title">
              {batchState === "rendering" && `Rendering clip ${batchDone + 1} of ${batchTotal}`}
              {batchState === "zipping" && "Saving ZIP…"}
              {batchState === "done" && "All done!"}
            </h3>

            <p className="batch-modal-sub">
              {batchState === "rendering" && "Please wait — clips are rendered one by one"}
              {batchState === "zipping" && "Packaging rendered clips into a ZIP file"}
              {batchState === "done" && "Your ZIP has been saved successfully"}
            </p>

            {batchState !== "done" && (
              <div className="batch-modal-progress">
                <div className="batch-modal-progress-track">
                  <div
                    className="batch-modal-progress-fill"
                    style={{
                      width: batchState === "zipping"
                        ? "100%"
                        : `${Math.round((batchDone / Math.max(batchTotal, 1)) * 100)}%`,
                    }}
                  />
                </div>
                <span className="batch-modal-progress-label">
                  {batchState === "zipping" ? "Zipping…" : `${batchDone} / ${batchTotal} done`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

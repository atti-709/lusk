import {
  useState,
  useCallback,
  type DragEvent,
  type ChangeEvent,
} from "react";
import "./UploadZone.css";

interface UploadState {
  status: "idle" | "dragging" | "uploading" | "done" | "error";
  fileName?: string;
  error?: string;
}

interface UploadZoneProps {
  onUploadComplete: (sessionId: string) => void;
}

export function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const [state, setState] = useState<UploadState>({ status: "idle" });

  const handleUpload = useCallback(
    async (file: File) => {
      setState({ status: "uploading", fileName: file.name });

      const formData = new FormData();
      formData.append("file", file);

      try {
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        const data = await response.json();
        setState({ status: "done", fileName: file.name });
        onUploadComplete(data.sessionId);
      } catch (err) {
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [onUploadComplete]
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setState((s) => ({ ...s, status: "idle" }));
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setState((s) => ({ ...s, status: "dragging" }));
  }, []);

  const onDragLeave = useCallback(() => {
    setState((s) => ({ ...s, status: "idle" }));
  }, []);

  const onFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  return (
    <div
      className={`upload-zone ${state.status}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {state.status === "idle" && (
        <>
          <div className="upload-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="upload-title">Drop your podcast video here</p>
          <p className="upload-hint">or</p>
          <label className="browse-btn">
            Browse files
            <input
              type="file"
              accept="video/*"
              onChange={onFileSelect}
              hidden
            />
          </label>
          <p className="upload-formats">MP4, MOV, WEBM up to 2 GB</p>
        </>
      )}

      {state.status === "dragging" && (
        <div className="drop-ready">
          <div className="upload-icon pulse">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="upload-title">Release to upload</p>
        </div>
      )}

      {state.status === "uploading" && (
        <div className="uploading-state">
          <div className="spinner" />
          <p className="upload-title">Uploading {state.fileName}</p>
        </div>
      )}

      {state.status === "done" && (
        <p className="upload-title">Uploaded: {state.fileName}</p>
      )}

      {state.status === "error" && (
        <div className="error-state">
          <p className="error-message">{state.error}</p>
          <button
            className="secondary"
            onClick={() => setState({ status: "idle" })}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

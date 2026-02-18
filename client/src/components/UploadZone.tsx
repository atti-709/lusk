import { useState, useCallback, type DragEvent, type ChangeEvent } from "react";

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

  const handleUpload = useCallback(async (file: File) => {
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
  }, [onUploadComplete]);

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
          <p>Drag & drop a video file here</p>
          <label className="file-label">
            or click to browse
            <input
              type="file"
              accept="video/*"
              onChange={onFileSelect}
              hidden
            />
          </label>
        </>
      )}

      {state.status === "dragging" && <p>Drop your video here</p>}

      {state.status === "uploading" && (
        <p>Uploading {state.fileName}...</p>
      )}

      {state.status === "done" && (
        <p>Uploaded: {state.fileName}</p>
      )}

      {state.status === "error" && (
        <div>
          <p className="error">{state.error}</p>
          <button onClick={() => setState({ status: "idle" })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

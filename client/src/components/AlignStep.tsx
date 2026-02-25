import { useState, useCallback, useEffect } from "react";
import type { ViralClip } from "@lusk/shared";

interface AlignStepProps {
  sessionId: string;
}

export function AlignStep({ sessionId }: AlignStepProps) {
  const [correctionCopied, setCorrectionCopied] = useState(false);
  const [viralCopied, setViralCopied] = useState(false);
  const [correctedTsv, setCorrectedTsv] = useState("");
  const [viralText, setViralText] = useState("");
  const [correctionPrompt, setCorrectionPrompt] = useState("");
  const [viralClipPrompt, setViralClipPrompt] = useState("");
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [submitError, setSubmitError] = useState("");
  const [videoName, setVideoName] = useState("project");

  // Fetch prompts on mount
  useEffect(() => {
    fetch("/prompts/correction.md")
      .then((res) => res.text())
      .then(setCorrectionPrompt)
      .catch(() => {});
      
    fetch("/prompts/viral-clips.md")
      .then((res) => res.text())
      .then(setViralClipPrompt)
      .catch(() => {});
  }, []);

  // Prefill data from session
  useEffect(() => {
    fetch(`/api/project/${sessionId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;

        // 1. Prefill corrected transcript from raw text if available
        if (data.correctedTranscriptRaw) {
          setCorrectedTsv(data.correctedTranscriptRaw);
        }

        if (data.videoName) {
          setVideoName(data.videoName);
        }

        // 2. Prefill viral clips
        if (data.viralClips?.length) {
          const text = (data.viralClips as ViralClip[]).map((clip: ViralClip, i: number) => {
            const fmt = (ms: number) => {
              const h = Math.floor(ms / 3600000);
              const m = Math.floor((ms % 3600000) / 60000);
              const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
              return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s}`;
            };
            return `CLIP ${i + 1}\nTitle: ${clip.title}\nHook: ${clip.hookText}\nStart: ${fmt(clip.startMs)}\nEnd: ${fmt(clip.endMs)}`;
          }).join("\n\n");
          setViralText(text);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  const handleDownloadTsv = useCallback(async () => {
    const res = await fetch(`/api/project/${sessionId}/transcript.tsv`);
    if (!res.ok) return;
    
    // Check content type to determine extension (zip vs tsv)
    const contentType = res.headers.get("Content-Type") || "";
    const isZip = contentType.includes("zip");
    const filename = isZip ? `${videoName}_transcription.zip` : `${videoName}_transcription.tsv`;

    const blob = await res.blob();

    if ("showSaveFilePicker" in window) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: isZip 
            ? [{ description: "ZIP Archive", accept: { "application/zip": [".zip"] } }]
            : [{ description: "TSV File", accept: { "text/tab-separated-values": [".tsv"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (err.name === "AbortError") return;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionId, videoName]);

  const handleCopyPrompt = useCallback(async (text: string, setter: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }, []);

  const handleSubmitClips = useCallback(async () => {
    setSubmitStatus("submitting");
    setSubmitError("");

    try {
      // Auto-save the corrected transcript first
      if (correctedTsv.trim()) {
        const tsvRes = await fetch(`/api/project/${sessionId}/corrected-transcript`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: correctedTsv }),
        });
        if (!tsvRes.ok) {
          const err = await tsvRes.json();
          throw new Error(err.error || "Failed to save transcript");
        }
      }

      // Then submit viral clips
      const res = await fetch(`/api/project/${sessionId}/viral-clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: viralText }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to parse clips");
      }

      // Success — the server transitions to READY, SSE will update the UI
    } catch (err) {
      setSubmitStatus("error");
      setSubmitError(err instanceof Error ? err.message : "Submit failed");
    }
  }, [sessionId, viralText, correctedTsv]);

  return (
    <div className="align-step">
      <h2 className="align-step-title">Align & Analyze with Gemini</h2>

      {/* Section 1: Download TSV */}
      <div className="align-section">
        <div className="align-section-header">
          <span className="align-section-number">1</span>
          <h3>Download Transcript</h3>
        </div>
        <p className="align-section-desc">Download the raw transcript to correct it with Gemini.</p>
        <button className="primary" onClick={handleDownloadTsv}>
          Download TSV
        </button>
      </div>

      {/* Section 2: Copy Correction Prompt */}
      <div className="align-section">
        <div className="align-section-header">
          <span className="align-section-number">2</span>
          <h3>Correct Transcript with Gemini</h3>
        </div>
        <p className="align-section-desc">
          Upload the TSV and your original script (markdown) to Gemini, then paste the prompt below.
        </p>
        <pre className="align-prompt-box">{correctionPrompt}</pre>
        <button
          className="secondary"
          onClick={() => handleCopyPrompt(correctionPrompt, setCorrectionCopied)}
        >
          {correctionCopied ? "✓ Copied!" : "Copy Prompt"}
        </button>
      </div>

      {/* Section 3: Paste Corrected TSV */}
      <div className="align-section">
        <div className="align-section-header">
          <span className="align-section-number">3</span>
          <h3>Paste Corrected Transcript</h3>
        </div>
        <p className="align-section-desc">
          Paste the corrected TSV from Gemini's output below. It will be saved automatically when you click Next.
        </p>
        <textarea
          className="align-textarea"
          placeholder={"00:00:01.234\tPrvé\n00:00:01.567\tslovo\n..."}
          value={correctedTsv}
          onChange={(e) => setCorrectedTsv(e.target.value)}
          rows={10}
        />
      </div>

      {/* Section 4: Copy Viral Clip Prompt */}
      <div className="align-section">
        <div className="align-section-header">
          <span className="align-section-number">4</span>
          <h3>Find Viral Clips with Gemini</h3>
        </div>
        <p className="align-section-desc">
          Paste this as your next message in the same Gemini chat.
        </p>
        <pre className="align-prompt-box">{viralClipPrompt}</pre>
        <button
          className="secondary"
          onClick={() => handleCopyPrompt(viralClipPrompt, setViralCopied)}
        >
          {viralCopied ? "✓ Copied!" : "Copy Prompt"}
        </button>
      </div>

      {/* Section 5: Paste Viral Clips */}
      <div className="align-section">
        <div className="align-section-header">
          <span className="align-section-number">5</span>
          <h3>Paste Viral Clips</h3>
        </div>
        <p className="align-section-desc">
          Paste Gemini's viral clip response below and click Next.
        </p>
        <textarea
          className="align-textarea"
          placeholder={"CLIP 1\nTitle: ...\nHook: ...\nStart: 00:01:23.456\nEnd: 00:02:10.789\n\nCLIP 2\n..."}
          value={viralText}
          onChange={(e) => setViralText(e.target.value)}
          rows={8}
        />
        {submitStatus === "error" && <p className="align-status error">{submitError}</p>}
        <button
          className="primary"
          onClick={handleSubmitClips}
          disabled={submitStatus === "submitting"}
        >
          {submitStatus === "submitting" ? "Processing…" : "Next →"}
        </button>
      </div>
    </div>
  );
}

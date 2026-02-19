import { useState, useCallback, useEffect } from "react";
import type { ViralClip } from "@lusk/shared";

interface AlignStepProps {
  sessionId: string;
}

const CORRECTION_PROMPT = `# Task: Word-Level Transcription Alignment and Correction (Slovak)

I have uploaded two files with this prompt:
1. A **.md** file containing the master reference script.
2. A **.tsv** file containing a raw word-level transcription chunk (Format: \`Timestamp\` [TAB] \`Word/Phrase\`).

### Your Role:
Act as a professional Slovak editor. Your goal is to fetch and read both files, then correct the text in the **.tsv** file using the **.md** text as your definitive master reference for accuracy, names, and theology.

### Strict Guidelines:
1. **Maintain Format:** The output must remain a valid **.tsv**. Do not add headers, extra columns, or change the timestamps in the first column.
2. **One-to-One Mapping:** Do NOT merge, split, or delete lines. Every row in the input must have exactly one corresponding row in the output to preserve video caption timing.
3. **Punctuation & Capitalization:** Base all capitalization and punctuation strictly on the .md reference text. Attach commas, periods, and other punctuation directly to the word immediately preceding them (e.g., \`slovo,\` not \`slovo ,\`).
4. **Slovak Grammar & Diacritics:**
   * Fix missing leading letters (e.g., \`akujem\` → \`Ďakujem\`).
   * Add missing accents (\`mäkčene\`, \`dĺžne\`).
   * Correct noun/adjective declensions (\`pády\`).
5. **Theological & Name Accuracy:** Ensure names and specialized terms match the .md reference text perfectly.
6. **Respect the Spoken Word:** If the host naturally deviated from the script but the spoken word is grammatically correct Slovak, keep it. Only fix AI hallucinations, misspellings, or mangled grammar.
7. **Filler Words:** If the speaker uses filler words (*vlastne*, *akože*, *ehm*) not present in the .md script, correct their spelling and keep them in the .tsv on their original timestamps to preserve the flow.

### Output:
Provide the corrected **.tsv** content inside a single code block. Do not add any conversational text before or after the code block.`;

const VIRAL_CLIP_PROMPT = `Based on the corrected transcript, identify 3-5 segments (15-60 seconds each) that would make the most viral short-form video clips. Look for:
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments
- Surprising facts or revelations
- Moments with high energy or passion

Pay CRITICAL attention to clip boundaries, especially the ENDINGS:
1. **Start Strong:** Each clip must START at the beginning of a sentence or a clear thought. Never start mid-sentence.
2. **Narrative Closure:** The end of the clip MUST resolve the premise introduced in the hook. Do not end the clip just because you reached the 40-second mark. If the current thought requires the next sentence to make sense, include it.
3. **The "Mic-Drop" Rule:** The final sentence should feel like a natural, impactful conclusion, punchline, or thought-provoking statement. It should leave the viewer satisfied, not confused.
4. **Avoid Cliffhangers:** Ensure the final sentence does not accidentally introduce a brand new idea that gets cut off. 

For each clip, provide the output in EXACTLY this format:

CLIP 1
Title: [Short catchy title for the clip]
Hook: [The opening hook text that grabs attention]
Start: [Timestamp of the first word, copied exactly from the TSV]
End: [Timestamp of the last word, copied exactly from the TSV]

CLIP 2
Title: ...
Hook: ...
Start: ...
End: ...

IMPORTANT: Verify that the exact text between your chosen Start and End timestamps forms a complete, logical, and satisfying narrative from start to finish. Use the exact timestamps from the TSV file. Do not approximate.`;

export function AlignStep({ sessionId }: AlignStepProps) {
  const [correctionCopied, setCorrectionCopied] = useState(false);
  const [viralCopied, setViralCopied] = useState(false);
  const [correctedTsv, setCorrectedTsv] = useState("");
  const [viralText, setViralText] = useState("");
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [submitError, setSubmitError] = useState("");

  // Prefill both textareas from session data
  useEffect(() => {
    // Prefill corrected TSV
    fetch(`/api/project/${sessionId}/transcript.tsv`)
      .then((res) => (res.ok ? res.text() : ""))
      .then((text) => {
        if (text) setCorrectedTsv(text);
      })
      .catch(() => {});

    // Prefill viral clips text from stored clips
    fetch(`/api/project/${sessionId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.viralClips?.length) {
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcription.tsv";
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionId]);

  const handleCopyPrompt = useCallback(async (text: string, setter: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }, []);

  const handleSubmitClips = useCallback(async () => {
    if (!viralText.trim()) return;

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
        <pre className="align-prompt-box">{CORRECTION_PROMPT}</pre>
        <button
          className="secondary"
          onClick={() => handleCopyPrompt(CORRECTION_PROMPT, setCorrectionCopied)}
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
        <pre className="align-prompt-box">{VIRAL_CLIP_PROMPT}</pre>
        <button
          className="secondary"
          onClick={() => handleCopyPrompt(VIRAL_CLIP_PROMPT, setViralCopied)}
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
          disabled={!viralText.trim() || submitStatus === "submitting"}
        >
          {submitStatus === "submitting" ? "Processing…" : "Next →"}
        </button>
      </div>
    </div>
  );
}

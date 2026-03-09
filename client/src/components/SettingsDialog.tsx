import { useState, useEffect, useCallback } from "react";
import { useAppSettings } from "../contexts/AppSettingsContext";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onKeySet?: (isSet: boolean) => void;
}

const LANGUAGES = [
  { value: "sk", label: "Slovenčina" },
  { value: "cs", label: "Čeština" },
  { value: "en", label: "English" },
] as const;

const FPS_OPTIONS = [
  { value: 23.976, label: "23.976 (Film)" },
  { value: 24, label: "24" },
  { value: 25, label: "25 (PAL)" },
  { value: 29.97, label: "29.97 (NTSC)" },
  { value: 30, label: "30" },
  { value: 50, label: "50" },
  { value: 59.94, label: "59.94" },
  { value: 60, label: "60" },
];

const PROMPT_FIELDS = [
  { key: "correctionPrompt", label: "Correction Prompt", hint: "System prompt for transcript correction via Gemini" },
  { key: "viralClipsPrompt", label: "Viral Clips Prompt", hint: "System prompt for viral clip detection via Gemini" },
] as const;

type PromptKey = (typeof PROMPT_FIELDS)[number]["key"];

export function SettingsDialog({ open, onClose, onKeySet }: SettingsDialogProps) {
  const appSettings = useAppSettings();
  const [apiKey, setApiKey] = useState("");
  const [isSet, setIsSet] = useState(false);
  const [language, setLanguage] = useState("sk");
  const [fpsValue, setFpsValue] = useState(23.976);
  const [outroOverlapFrames, setOutroOverlapFrames] = useState(4);
  const [outroSet, setOutroSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Prompt state: null = using default, string = custom
  const [prompts, setPrompts] = useState<Record<PromptKey, string | null>>({
    correctionPrompt: null,
    viralClipsPrompt: null,
  });
  const [defaults, setDefaults] = useState<Record<PromptKey, string>>({
    correctionPrompt: "",
    viralClipsPrompt: "",
  });
  const [expandedPrompt, setExpandedPrompt] = useState<PromptKey | null>(null);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/settings/default-prompts").then((r) => r.json()),
    ])
      .then(([settings, defaultPrompts]) => {
        setIsSet(settings.geminiApiKeySet);
        if (settings.geminiApiKeySet) setApiKey("");
        if (settings.transcriptionLanguage) setLanguage(settings.transcriptionLanguage);
        setFpsValue(settings.fps ?? 23.976);
        setOutroOverlapFrames(settings.outroOverlapFrames ?? 4);
        setOutroSet(settings.outroSet ?? false);
        setPrompts({
          correctionPrompt: settings.correctionPrompt ?? null,
          viralClipsPrompt: settings.viralClipsPrompt ?? null,
        });
        setDefaults({
          correctionPrompt: defaultPrompts.correctionPrompt,
          viralClipsPrompt: defaultPrompts.viralClipsPrompt,
        });
      })
      .catch(() => {});
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Record<string, string | number | null> = {
        transcriptionLanguage: language,
        fps: fpsValue,
        outroOverlapFrames,
      };
      if (apiKey.trim()) body.geminiApiKey = apiKey;
      // Send prompts: null means reset to default, string means custom
      for (const { key } of PROMPT_FIELDS) {
        body[key] = prompts[key];
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (apiKey.trim()) {
          setIsSet(true);
          onKeySet?.(true);
        }
        appSettings.reload();
        setStatus("Saved");
        setTimeout(() => setStatus(null), 2000);
      }
    } catch {
      setStatus("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [apiKey, language, fpsValue, outroOverlapFrames, prompts, appSettings]);

  const handleOutroUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("outro", file);
    try {
      const res = await fetch("/api/settings/outro", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        setOutroSet(true);
        appSettings.reload();
        setStatus("Outro uploaded");
        setTimeout(() => setStatus(null), 2000);
      }
    } catch {
      setStatus("Failed to upload outro");
    }
  }, [appSettings]);

  const handleOutroDelete = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/outro", { method: "DELETE" });
      if (res.ok) {
        setOutroSet(false);
        appSettings.reload();
        setStatus("Outro removed");
        setTimeout(() => setStatus(null), 2000);
      }
    } catch {
      setStatus("Failed to remove outro");
    }
  }, [appSettings]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="settings-field">
          <label htmlFor="transcription-language">Transcription Language</label>
          <select
            id="transcription-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
          <p className="settings-hint">
            Language used for WhisperX transcription and alignment
          </p>
        </div>
        <div className="settings-field">
          <label htmlFor="gemini-key">Gemini API Key</label>
          <input
            id="gemini-key"
            type="password"
            placeholder={isSet ? "Key is set (enter new to replace)" : "Enter your Gemini API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="settings-hint">
            Get a key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-fps">FPS</label>
          <select
            id="settings-fps"
            value={fpsValue}
            onChange={(e) => setFpsValue(Number(e.target.value))}
          >
            {FPS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="settings-hint">
            Frame rate used for rendering and preview
          </p>
        </div>

        <div className="settings-field">
          <label>Outro</label>
          <div className={`settings-outro-status${outroSet ? " active" : ""}`}>
            {outroSet ? "Outro configured" : "No outro"}
          </div>
          <div className="settings-outro-actions">
            <input
              type="file"
              accept="video/mp4"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleOutroUpload(file);
                e.target.value = "";
              }}
            />
            {outroSet && (
              <button className="secondary" onClick={handleOutroDelete}>
                Remove
              </button>
            )}
          </div>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-overlap">Outro Overlap Frames</label>
          <input
            id="settings-overlap"
            type="number"
            min={0}
            max={30}
            step={1}
            value={outroOverlapFrames}
            onChange={(e) => setOutroOverlapFrames(Number(e.target.value))}
          />
          <p className="settings-hint">
            Number of frames the outro overlaps the end of the main clip
          </p>
        </div>

        {PROMPT_FIELDS.map(({ key, label, hint }) => (
          <div className="settings-field" key={key}>
            <div className="settings-prompt-header">
              <label
                className="settings-prompt-toggle"
                onClick={() => setExpandedPrompt(expandedPrompt === key ? null : key)}
              >
                <span className="settings-prompt-arrow">{expandedPrompt === key ? "▼" : "▶"}</span>
                {label}
                {prompts[key] !== null && <span className="settings-badge">Custom</span>}
              </label>
              {prompts[key] !== null && (
                <button
                  className="settings-reset-btn"
                  onClick={() => setPrompts((p) => ({ ...p, [key]: null }))}
                >
                  Reset to default
                </button>
              )}
            </div>
            {expandedPrompt === key && (
              <>
                <textarea
                  className="settings-prompt-textarea"
                  value={prompts[key] ?? defaults[key]}
                  onChange={(e) =>
                    setPrompts((p) => ({
                      ...p,
                      [key]: e.target.value === defaults[key] ? null : e.target.value,
                    }))
                  }
                  rows={12}
                />
                <p className="settings-hint">{hint}</p>
              </>
            )}
          </div>
        ))}

        <div className="settings-actions">
          {status && <span className="settings-status">{status}</span>}
          <button className="secondary" onClick={onClose}>Close</button>
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

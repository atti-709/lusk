import { useState, useEffect, useCallback } from "react";

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

export function SettingsDialog({ open, onClose, onKeySet }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [isSet, setIsSet] = useState(false);
  const [language, setLanguage] = useState("sk");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setIsSet(data.geminiApiKeySet);
        if (data.geminiApiKeySet) {
          setApiKey(""); // Don't show the actual key
        }
        if (data.transcriptionLanguage) {
          setLanguage(data.transcriptionLanguage);
        }
      })
      .catch(() => {});
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Record<string, string> = { transcriptionLanguage: language };
      if (apiKey.trim()) body.geminiApiKey = apiKey;
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
        setStatus("Saved");
        setTimeout(() => setStatus(null), 2000);
      }
    } catch {
      setStatus("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [apiKey, language]);

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

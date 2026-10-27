import { useEffect, useState } from "react";
import { DEFAULT_PROJECT_LANGUAGE, parseProjectLanguage, type ProjectLanguage } from "@lusk/shared";

export const LANGUAGE_OPTIONS: { value: ProjectLanguage; label: string }[] = [
  { value: "sk", label: "Slovenčina" },
  { value: "cs", label: "Čeština" },
  { value: "en", label: "English" },
];

interface NewProjectDialogProps {
  open: boolean;
  onCancel: () => void;
  onCreate: (language: ProjectLanguage) => void;
}

/** Asks for the project's spoken language. It is fixed for the project; Settings only sets the default offered here. */
export function NewProjectDialog({ open, onCancel, onCreate }: NewProjectDialogProps) {
  const [language, setLanguage] = useState<ProjectLanguage>(DEFAULT_PROJECT_LANGUAGE);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { if (live) setLanguage(parseProjectLanguage(s.transcriptionLanguage)); })
      .catch(() => {});
    return () => { live = false; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onCancel}>
      <div className="settings-dialog" data-testid="new-project-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>
        <div className="settings-field">
          <label htmlFor="new-project-language">Spoken language</label>
          <select
            id="new-project-language"
            value={language}
            onChange={(e) => setLanguage(parseProjectLanguage(e.target.value))}
          >
            {LANGUAGE_OPTIONS.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
          <p className="settings-hint">
            Used for transcription, proofreading, translation and subtitle export of this project.
          </p>
        </div>
        <div className="settings-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" data-testid="new-project-create" onClick={() => onCreate(language)}>Create</button>
        </div>
      </div>
    </div>
  );
}

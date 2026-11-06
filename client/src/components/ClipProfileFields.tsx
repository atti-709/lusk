import { useState } from "react";
import type { ClipSettings, ContentProfile } from "@lusk/shared";
import { parseContentProfile } from "@lusk/shared";

export const PROFILE_OPTIONS: { value: ContentProfile; label: string }[] = [
  { value: "podcast", label: "Podcast" },
  { value: "sermon", label: "Sermon" },
];

/** What each profile asks for when the overrides are empty (mirrors server/src/services/clipProfile.ts). */
const PROFILE_DEFAULTS: Record<ContentProfile, { range: string; count: string; hint: string }> = {
  podcast: { range: "20-30", count: "up to 16", hint: "Short, punchy moments with a hook." },
  sermon: {
    range: "30-60",
    count: "one per 4 min (6-24)",
    hint: "Complete thoughts: a verse with its application, main points and stories. Skips worship, announcements and the offering.",
  },
};

export interface ClipProfileValue {
  contentProfile: ContentProfile;
  clipSettings: ClipSettings;
}

interface ClipProfileFieldsProps {
  value: ClipProfileValue;
  onChange: (next: ClipProfileValue) => void;
  idPrefix: string;
}

/** Profile choice plus the "Advanced" overrides (length range, count, instructions). */
export function ClipProfileFields({ value, onChange, idPrefix }: ClipProfileFieldsProps) {
  const { contentProfile, clipSettings } = value;
  const defaults = PROFILE_DEFAULTS[contentProfile];
  const hasOverrides = Object.keys(clipSettings).length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(hasOverrides);

  const setSetting = (key: "minSec" | "maxSec" | "count", raw: string) => {
    const next = { ...clipSettings };
    if (raw.trim() === "") delete next[key];
    else next[key] = Number(raw);
    onChange({ contentProfile, clipSettings: next });
  };

  return (
    <div className="clip-profile-fields" data-testid={`${idPrefix}-clip-profile`}>
      <div className="settings-field">
        <label htmlFor={`${idPrefix}-profile`}>Content type</label>
        <select
          id={`${idPrefix}-profile`}
          value={contentProfile}
          onChange={(e) => onChange({ contentProfile: parseContentProfile(e.target.value), clipSettings })}
        >
          {PROFILE_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <p className="settings-hint">
          Picks the clip prompt: {defaults.range} s clips, {defaults.count}. {defaults.hint}
          {contentProfile === "sermon" && " The custom clip prompt in Settings applies to podcasts only."}
        </p>
      </div>

      <details
        className="clip-advanced"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary data-testid={`${idPrefix}-advanced`}>Advanced</summary>
        <div className="clip-advanced-grid">
          <div className="settings-field">
            <label htmlFor={`${idPrefix}-min`}>Min length (s)</label>
            <input
              id={`${idPrefix}-min`}
              type="number"
              min={5}
              max={600}
              placeholder={defaults.range.split("-")[0]}
              value={clipSettings.minSec ?? ""}
              onChange={(e) => setSetting("minSec", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor={`${idPrefix}-max`}>Max length (s)</label>
            <input
              id={`${idPrefix}-max`}
              type="number"
              min={5}
              max={600}
              placeholder={defaults.range.split("-")[1]}
              value={clipSettings.maxSec ?? ""}
              onChange={(e) => setSetting("maxSec", e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor={`${idPrefix}-count`}>Clips (max)</label>
            <input
              id={`${idPrefix}-count`}
              type="number"
              min={1}
              max={60}
              placeholder="auto"
              value={clipSettings.count ?? ""}
              onChange={(e) => setSetting("count", e.target.value)}
            />
          </div>
        </div>
        <div className="settings-field">
          <label htmlFor={`${idPrefix}-instructions`}>Selection instructions</label>
          <textarea
            id={`${idPrefix}-instructions`}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Only clips about forgiveness. Skip the testimony at the start."
            value={clipSettings.instructions ?? ""}
            onChange={(e) => {
              const next = { ...clipSettings };
              if (e.target.value === "") delete next.instructions;
              else next.instructions = e.target.value;
              onChange({ contentProfile, clipSettings: next });
            }}
          />
          <p className="settings-hint">Added to the prompt for this project. Empty fields use the defaults above.</p>
        </div>
      </details>
    </div>
  );
}

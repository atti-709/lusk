import type { ClipSettings, ContentProfile } from "@lusk/shared";

/**
 * Clip detection per content profile: length range, count and the request text.
 *
 * The podcast profile is the original behaviour and must stay byte for byte what it was
 * (same prompt, same constraint lines, same count) unless the project sets overrides.
 */

/** Length range each profile asks Gemini for (seconds); overridable per project. */
export const PROFILE_CLIP_SECONDS: Record<ContentProfile, { minSec: number; maxSec: number }> = {
  podcast: { minSec: 20, maxSec: 30 },
  sermon: { minSec: 30, maxSec: 60 },
};

/** Sermon count: one clip per 4 minutes, at least 6, at most 24. */
export const SERMON_SECONDS_PER_CLIP = 240;
export const SERMON_MIN_CLIPS = 6;
export const SERMON_MAX_CLIPS = 24;

/** A clip shorter than this share of the asked-for minimum is a fragment (15 s of 20 s today). */
const FRAGMENT_RATIO = 0.75;

export function timestampSeconds(timestamp: string): number {
  const [h, m, sec] = timestamp.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
}

/** The length range in seconds a project asks for: its overrides over the profile's default. */
export function clipLengthRange(profile: ContentProfile, settings: ClipSettings = {}): { minSec: number; maxSec: number } {
  const base = PROFILE_CLIP_SECONDS[profile];
  const minSec = settings.minSec ?? base.minSec;
  const maxSec = Math.max(minSec, settings.maxSec ?? base.maxSec);
  return { minSec, maxSec };
}

/** Shortest clip (ms) kept after Gemini answers: the asked-for minimum less a tolerance. */
export function minClipMsFor(profile: ContentProfile, settings: ClipSettings = {}): number {
  return Math.round(clipLengthRange(profile, settings).minSec * 1000 * FRAGMENT_RATIO);
}

/**
 * The most clips asked for. Podcast: no more than one per ~35 s of transcript, capped at
 * the prompt's 16 (the original rule). Sermon: one per 4 minutes within 6-24.
 * A project's own count replaces either.
 */
export function maxClipsFor(lastTimestamp: string, profile: ContentProfile = "podcast", settings: ClipSettings = {}): number {
  if (settings.count) return settings.count;
  const totalSec = timestampSeconds(lastTimestamp);
  if (profile === "sermon") {
    return Math.max(SERMON_MIN_CLIPS, Math.min(SERMON_MAX_CLIPS, Math.floor(totalSec / SERMON_SECONDS_PER_CLIP)));
  }
  return Math.max(3, Math.min(16, Math.floor(totalSec / 35)));
}

/** Fill the sermon prompt's length placeholders. */
export function renderSermonPrompt(template: string, settings: ClipSettings = {}): string {
  const { minSec, maxSec } = clipLengthRange("sermon", settings);
  return template.replaceAll("{{MIN_SEC}}", String(minSec)).replaceAll("{{MAX_SEC}}", String(maxSec));
}

/**
 * The full request text. `prompt` is the profile's prompt, already rendered. For a podcast
 * project without overrides this is exactly the message the app always sent.
 */
export function buildClipUserMessage(
  prompt: string,
  lastTimestamp: string,
  correctedTsv: string,
  profile: ContentProfile = "podcast",
  settings: ClipSettings = {},
): string {
  const lines = [
    prompt,
    "",
    `CONSTRAINT: The transcript ends at ${lastTimestamp}. All start and end timestamps MUST fall within 00:00:00.000 – ${lastTimestamp}. Do NOT suggest clips that extend beyond this range.`,
    `CONSTRAINT: Return at most ${maxClipsFor(lastTimestamp, profile, settings)} clips, none overlapping another.`,
  ];
  // The podcast prompt states 20-30 s in prose; an override must say it wins
  if (profile === "podcast" && (settings.minSec !== undefined || settings.maxSec !== undefined)) {
    const { minSec, maxSec } = clipLengthRange(profile, settings);
    lines.push(`CONSTRAINT: Every clip MUST be ${minSec}-${maxSec} seconds long. This replaces any other duration stated above.`);
  }
  if (settings.instructions) {
    lines.push("", "## Additional selection instructions from the editor (follow them, within the rules above):", "", settings.instructions);
  }
  lines.push("", "## Corrected Transcript (.tsv):", "", correctedTsv);
  return lines.join("\n");
}

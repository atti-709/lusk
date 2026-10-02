import { useEffect, useState } from "react";
import type { Framing, FramingKeyframe, FramingMode } from "@lusk/shared";

export type FramingStatus = "idle" | "tracking" | "ready" | "error";

/** Wait this long after the last range/mode change before asking the server to track. */
const DEBOUNCE_MS = 600;

/**
 * Fetches the tracked camera path for a clip range from the server, which solves it
 * with Apple Vision (a few seconds per clip) and caches it — so the same range opens
 * instantly next time, and the render reuses the preview's solve.
 *
 * While a new solve runs the previous path stays up, so trimming a clip doesn't flash
 * the crop back to center.
 */
export function useFraming(
  sessionId: string,
  range: { startMs: number; endMs: number },
  mode: FramingMode,
  subjectX: number | undefined,
  subjectT: number | undefined,
  enabled: boolean,
): {
  keyframes: FramingKeyframe[] | null;
  fit: [number, number][] | null;
  status: FramingStatus;
  error: string | null;
} {
  const [keyframes, setKeyframes] = useState<FramingKeyframe[] | null>(null);
  const [fit, setFit] = useState<[number, number][] | null>(null);
  const [status, setStatus] = useState<FramingStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const active = enabled && mode !== "manual" && (mode !== "pick" || subjectX != null);

  useEffect(() => {
    if (!active) {
      setStatus("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setStatus("tracking");
      setError(null);
      try {
        const res = await fetch(`/api/projects/${sessionId}/framing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startMs: range.startMs, endMs: range.endMs, mode, subjectX, subjectT }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          // 409 = superseded by a newer request; that one reports instead
          if (res.status === 409) return;
          throw new Error(data.error ?? "Tracking failed");
        }
        setKeyframes((data as Framing).keyframes);
        setFit((data as Framing).fit ?? null);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, sessionId, range.startMs, range.endMs, mode, subjectX, subjectT]);

  return { keyframes: active ? keyframes : null, fit: active ? fit : null, status, error };
}

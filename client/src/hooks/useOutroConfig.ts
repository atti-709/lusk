import { useState, useEffect, useCallback } from "react";

export interface OutroConfig {
  outroSrc: string;
  outroDurationInFrames: number;
  outroOverlapFrames: number;
}

/**
 * Fetches the outro configuration from the server.
 * Returns null while loading or if no outro assets are configured.
 */
export function useOutroConfig(): { config: OutroConfig | null; reload: () => void } {
  const [config, setConfig] = useState<OutroConfig | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    fetch("/api/outro-config")
      .then((r) => r.json())
      .then((data: OutroConfig) => {
        if (data.outroSrc) setConfig(data);
        else setConfig(null);
      })
      .catch(() => {});
  }, [trigger]);

  const reload = useCallback(() => setTrigger((t) => t + 1), []);

  return { config, reload };
}

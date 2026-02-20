import { useState, useEffect } from "react";

export interface OutroConfig {
  outroSrc: string;
  outroDurationInFrames: number;
}

/**
 * Fetches the outro configuration from the server.
 * Returns null while loading or if no outro assets are configured.
 */
export function useOutroConfig(): OutroConfig | null {
  const [config, setConfig] = useState<OutroConfig | null>(null);

  useEffect(() => {
    fetch("/api/outro-config")
      .then((r) => r.json())
      .then((data: OutroConfig) => {
        if (data.outroSrc) setConfig(data);
      })
      .catch(() => {});
  }, []);

  return config;
}

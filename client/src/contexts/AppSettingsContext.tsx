import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";

interface AppSettingsCtx {
  fps: number;
  outroOverlapFrames: number;
  outroSet: boolean;
  outroEnabled: boolean;
  loading: boolean;
  captionStyles: CaptionStyles;
  reload: () => void;
  updateCaptionStyles: (styles: CaptionStyles) => void;
  setOutroEnabled: (enabled: boolean) => void;
}

const AppSettingsContext = createContext<AppSettingsCtx>({
  fps: 23.976,
  outroOverlapFrames: 4,
  outroSet: false,
  outroEnabled: true,
  loading: true,
  captionStyles: DEFAULT_CAPTION_STYLES,
  reload: () => {},
  updateCaptionStyles: () => {},
  setOutroEnabled: () => {},
});

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [fps, setFps] = useState(23.976);
  const [outroOverlapFrames, setOutroOverlapFrames] = useState(4);
  const [outroSet, setOutroSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [outroEnabled, setOutroEnabledState] = useState(true);
  const [captionStyles, setCaptionStyles] = useState<CaptionStyles>(DEFAULT_CAPTION_STYLES);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setFps(data.fps ?? 23.976);
        setOutroOverlapFrames(data.outroOverlapFrames ?? 4);
        setOutroSet(data.outroSet ?? false);
        setOutroEnabledState(data.outroEnabled ?? true);
        const serverStyles = data.captionStyles;
        if (serverStyles) {
          setCaptionStyles({ ...DEFAULT_CAPTION_STYLES, ...serverStyles });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const setOutroEnabled = useCallback(async (enabled: boolean) => {
    setOutroEnabledState(enabled);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outroEnabled: enabled }),
    });
  }, []);

  const updateCaptionStyles = useCallback(async (styles: CaptionStyles) => {
    setCaptionStyles(styles);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captionStyles: styles }),
    });
  }, []);

  return (
    <AppSettingsContext.Provider value={{ fps, outroOverlapFrames, outroSet, outroEnabled, loading, captionStyles, reload: load, updateCaptionStyles, setOutroEnabled }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}

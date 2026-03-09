import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface AppSettingsCtx {
  fps: number;
  outroOverlapFrames: number;
  outroSet: boolean;
  loading: boolean;
  reload: () => void;
}

const AppSettingsContext = createContext<AppSettingsCtx>({
  fps: 23.976,
  outroOverlapFrames: 4,
  outroSet: false,
  loading: true,
  reload: () => {},
});

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [fps, setFps] = useState(23.976);
  const [outroOverlapFrames, setOutroOverlapFrames] = useState(4);
  const [outroSet, setOutroSet] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setFps(data.fps ?? 23.976);
        setOutroOverlapFrames(data.outroOverlapFrames ?? 4);
        setOutroSet(data.outroSet ?? false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <AppSettingsContext.Provider value={{ fps, outroOverlapFrames, outroSet, loading, reload: load }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}

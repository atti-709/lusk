import { useState, useEffect, useRef } from "react";

export function UpdateOverlay() {
  const [visible, setVisible] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const dismissTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const lusk = window.lusk;
    if (!lusk) return;

    const cleanupDownloading = lusk.onUpdateDownloading(() => {
      setVisible(true);
      setPercent(0);
      setError(null);
    });

    const cleanupProgress = lusk.onUpdateProgress((p) => {
      setPercent(p);
    });

    const cleanupError = lusk.onUpdateError((msg) => {
      setError(msg);
      dismissTimeout.current = setTimeout(() => {
        setVisible(false);
        setError(null);
      }, 5000);
    });

    return () => {
      cleanupDownloading();
      cleanupProgress();
      cleanupError();
      if (dismissTimeout.current) clearTimeout(dismissTimeout.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="update-overlay">
      <div className="update-overlay-content">
        {error ? (
          <>
            <h2>Update Failed</h2>
            <p>{error}</p>
          </>
        ) : (
          <>
            <h2>Downloading Update...</h2>
            <div className="update-progress-track">
              <div
                className="update-progress-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p>{Math.round(percent)}%</p>
            {percent >= 100 && <p className="update-restarting">Installing and restarting...</p>}
          </>
        )}
      </div>
    </div>
  );
}

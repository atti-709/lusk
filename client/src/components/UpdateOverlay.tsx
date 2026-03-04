import { useState, useEffect } from "react";

export function UpdateOverlay() {
  const [visible, setVisible] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lusk = window.lusk;
    if (!lusk) return;

    lusk.onUpdateDownloading(() => {
      setVisible(true);
      setPercent(0);
      setError(null);
    });

    lusk.onUpdateProgress((p) => {
      setPercent(p);
    });

    lusk.onUpdateError((msg) => {
      setError(msg);
      // Auto-dismiss after 5 seconds on error
      setTimeout(() => {
        setVisible(false);
        setError(null);
      }, 5000);
    });
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

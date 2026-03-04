# Auto-Update Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix auto-update so restart works, block UI during download with progress overlay, and auto-restart after download completes.

**Architecture:** IPC bridge sends update events from main process to renderer. Renderer shows a full-screen blocking overlay with progress bar. Main process auto-restarts after download completes (no second dialog).

**Tech Stack:** Electron, electron-updater, React, IPC

---

### Task 1: Add update IPC channels to preload bridge

**Files:**
- Modify: `electron/src/preload.ts`

**Step 1: Add three IPC listeners to the preload bridge**

Add after the existing `writeFile` entry:

```typescript
  onUpdateDownloading: (callback: () => void) => {
    ipcRenderer.on("update-downloading", () => callback());
  },

  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on("update-progress", (_event, percent: number) => callback(percent));
  },

  onUpdateError: (callback: (message: string) => void) => {
    ipcRenderer.on("update-error", (_event, message: string) => callback(message));
  },
```

**Step 2: Commit**

```bash
git add electron/src/preload.ts
git commit -m "feat: add update IPC channels to preload bridge"
```

---

### Task 2: Update TypeScript definitions

**Files:**
- Modify: `client/src/lusk.d.ts`

**Step 1: Add the three new methods to LuskBridge interface**

Add after `writeFile`:

```typescript
  onUpdateDownloading: (callback: () => void) => void;
  onUpdateProgress: (callback: (percent: number) => void) => void;
  onUpdateError: (callback: (message: string) => void) => void;
```

**Step 2: Commit**

```bash
git add client/src/lusk.d.ts
git commit -m "feat: add update IPC types to LuskBridge"
```

---

### Task 3: Fix main process auto-updater

**Files:**
- Modify: `electron/src/main.ts` (function `setupAutoUpdater`, lines 187-239)

**Step 1: Replace the entire `setupAutoUpdater` function**

```typescript
function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", async (info) => {
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Available",
      message: `A new version (${info.version}) is available.`,
      detail: "Would you like to download it now?",
      buttons: ["Download", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      mainWindow.webContents.send("update-downloading");
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(progress.percent / 100);
    mainWindow.webContents.send("update-progress", progress.percent);
  });

  autoUpdater.on("update-downloaded", () => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(-1);
    isQuitting = true;
    killServer();
    autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on("error", (err) => {
    if (!mainWindow) return;
    mainWindow.setProgressBar(-1);
    mainWindow.webContents.send("update-error", err.message ?? "Download failed");
    console.error("Auto-updater error:", err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.log("Update check failed (offline?):", err.message);
  });
}
```

Key changes:
- `autoInstallOnAppQuit = false` — fixes the restart issue
- `update-available`: sends `update-downloading` IPC then downloads (no more progress bar on "Download" click — the renderer handles progress)
- `download-progress`: sends `update-progress` IPC with percent to renderer, plus dock progress bar
- `update-downloaded`: no dialog — immediately sets `isQuitting = true`, kills server, calls `quitAndInstall(false, true)` for forced restart
- `error`: sends `update-error` IPC to dismiss the overlay

**Step 2: Commit**

```bash
git add electron/src/main.ts
git commit -m "fix: auto-updater restart and blocking download flow"
```

---

### Task 4: Create UpdateOverlay component

**Files:**
- Create: `client/src/components/UpdateOverlay.tsx`

**Step 1: Create the component**

```tsx
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
```

**Step 2: Commit**

```bash
git add client/src/components/UpdateOverlay.tsx
git commit -m "feat: add UpdateOverlay component for blocking download UI"
```

---

### Task 5: Add UpdateOverlay CSS

**Files:**
- Modify: `client/src/App.css`

**Step 1: Add styles at the end of App.css**

```css
/* ── Update overlay ── */
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  -webkit-app-region: no-drag;
}

.update-overlay-content {
  text-align: center;
  color: #fff;
  max-width: 360px;
}

.update-overlay-content h2 {
  font-size: 1.25rem;
  margin-bottom: 1rem;
}

.update-overlay-content p {
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.5rem;
}

.update-progress-track {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  overflow: hidden;
}

.update-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.update-restarting {
  color: var(--accent) !important;
  margin-top: 1rem !important;
}
```

**Step 2: Commit**

```bash
git add client/src/App.css
git commit -m "style: add UpdateOverlay styles"
```

---

### Task 6: Mount UpdateOverlay in App.tsx

**Files:**
- Modify: `client/src/App.tsx`

**Step 1: Add import at the top of App.tsx**

Add with the other component imports:

```typescript
import { UpdateOverlay } from "./components/UpdateOverlay";
```

**Step 2: Render UpdateOverlay as the first child inside `<div className="app">`**

After `<div className="app">` (line 533), before `<header>`:

```tsx
      <UpdateOverlay />
```

**Step 3: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: mount UpdateOverlay in app root"
```

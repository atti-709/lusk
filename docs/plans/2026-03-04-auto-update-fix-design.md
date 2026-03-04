# Auto-Update Fix: Blocking UI + Restart

## Problem

1. `quitAndInstall()` does not restart the app — `autoInstallOnAppQuit = true` defers install to quit instead of restarting immediately.
2. No UI blocks the user during download — only a dock progress bar. User can continue working, and if the app state changes mid-update it's confusing.
3. After download, a second dialog asks to restart. User can click "Later", then next launch shows the update dialog again.

## Design

### Flow

1. App checks for updates on startup (existing)
2. Update found → native dialog: "Version X available. Download now?" [Download / Later]
3. User clicks Download → IPC `update-downloading` → renderer shows **full-screen blocking overlay** with progress bar
4. `download-progress` → IPC `update-progress` with percentage → overlay updates
5. Download complete → auto-restart: `killServer()` + `quitAndInstall(false, true)` — no second dialog
6. Error → IPC `update-error` → overlay dismissed, error shown

### Changes

**Main process (`electron/src/main.ts`):**
- Set `autoInstallOnAppQuit = false`
- After user clicks Download: send `update-downloading` IPC, call `downloadUpdate()`
- On `download-progress`: send `update-progress` IPC with `progress.percent`
- On `update-downloaded`: guard server exit handler with `isQuitting = true`, `killServer()`, `autoUpdater.quitAndInstall(false, true)`
- On `error`: send `update-error` IPC

**Preload (`electron/src/preload.ts`):**
- Expose: `onUpdateDownloading(cb)`, `onUpdateProgress(cb: (percent: number) => void)`, `onUpdateError(cb: (message: string) => void)`

**Types (`client/src/lusk.d.ts`):**
- Add three new IPC listeners to `LuskBridge`

**Renderer:**
- New `UpdateOverlay` component: fixed full-screen overlay (z-index above everything), centered progress bar, "Downloading update vX.X.X..." text
- Mount at app root in `App.tsx`
- Listens to IPC channels, shows on `update-downloading`, updates on `update-progress`, hides on `update-error`

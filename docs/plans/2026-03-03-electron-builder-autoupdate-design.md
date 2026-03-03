# Electron Builder + Auto-Update Design

**Date:** 2026-03-03
**Status:** Approved

## Goal

Migrate from electron-forge to electron-builder, add auto-updates via GitHub Releases (electron-updater), add semver versioning workflow, and show a dependency check dialog when Python/WhisperX is missing.

## 1. Migration: electron-forge → electron-builder

**Remove:** `@electron-forge/cli`, `@electron-forge/maker-dmg`, `@electron-forge/maker-zip`
**Add:** `electron-builder`, `electron-updater`

Replace `forge.config.ts` with `electron-builder.config.ts`:
- `target: ["dmg", "zip"]` — DMG for install, ZIP required for macOS auto-updates
- `publish: { provider: "github", owner: "<owner>", repo: "lusk" }`
- `asar: false` — server needs real filesystem (ffmpeg, WhisperX, Remotion bundler)
- `extraResources: ["bundle/**"]`
- `mac.identity: null` — skip code signing for now

Bundle assembly (copying server/client/shared into `bundle/`) moves to a `beforeBuild` script.

## 2. Auto-Updates (electron-updater)

- On app launch, `autoUpdater.checkForUpdatesAndNotify()` checks GitHub Releases
- Compares release tag (e.g. `v1.0.1`) against `app.getVersion()`
- Downloads `.zip` update in background
- Shows dialog: "Update available — restart to install?"
- User clicks Restart → `autoUpdater.quitAndInstall()`

## 3. Versioning

Single source of truth: `electron/package.json` version field (currently `1.0.0`).

```bash
cd electron
npm version patch   # 1.0.0 → 1.0.1 (bug fix)
npm version minor   # 1.0.0 → 1.1.0 (new feature)
npm version major   # 1.0.0 → 2.0.0 (breaking change)
```

Full release:
```bash
cd electron && npm version patch && cd ..
npm run package   # builds + uploads to GitHub Releases
```

## 4. Dependency Check Dialog

After server starts, check `/api/health` for `whisperxAvailable`. If false:
- Show warning dialog with install commands (`brew install python3`, `pip3 install whisperx`)
- "Copy Commands to Clipboard" button
- Non-blocking — user can continue using the app without transcription
- No ffmpeg check needed (bundled via ffmpeg-static)

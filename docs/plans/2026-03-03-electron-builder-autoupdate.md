# Electron Builder + Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate from electron-forge to electron-builder, add auto-updates via GitHub Releases, semver versioning workflow, and a dependency check dialog for missing Python/WhisperX.

**Architecture:** Replace electron-forge packaging with electron-builder. The bundle assembly logic (copying server/client/shared) moves to a standalone `scripts/bundle.ts` script run before electron-builder. Auto-updates use `electron-updater` checking GitHub Releases. A dependency dialog checks the server health endpoint after startup.

**Tech Stack:** electron-builder, electron-updater, GitHub Releases

---

### Task 1: Remove electron-forge dependencies

**Files:**
- Modify: `electron/package.json`

**Step 1: Update electron/package.json**

Remove forge deps and scripts, add electron-builder and electron-updater:

```json
{
  "name": "@lusk/electron",
  "private": true,
  "version": "1.0.0",
  "description": "Lusk – Viral Shorts from Slovak Podcasts",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "start": "electron .",
    "bundle": "tsx scripts/bundle.ts",
    "dist": "npm run bundle && electron-builder --publish never",
    "release": "npm run bundle && electron-builder --publish always"
  },
  "dependencies": {
    "electron-updater": "^6.3.0",
    "ffmpeg-static": "^5.2.0",
    "ffprobe-static": "^3.1.0"
  },
  "devDependencies": {
    "electron": "^33.3.1",
    "electron-builder": "^25.1.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Delete forge.config.ts**

Delete: `electron/forge.config.ts`

**Step 3: Install new dependencies**

Run: `cd /Users/atti/Source/Repos/lusk && npm install`
Expected: Clean install with electron-builder and electron-updater resolved.

**Step 4: Commit**

```bash
git add electron/package.json package-lock.json
git rm electron/forge.config.ts
git commit -m "refactor: replace electron-forge with electron-builder"
```

---

### Task 2: Create the bundle assembly script

**Files:**
- Create: `electron/scripts/bundle.ts`

**Step 1: Write the bundle script**

This script replaces the forge `prePackage` hook. It assembles server, client, and shared into `electron/bundle/`.

```typescript
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BUNDLE = path.join(ROOT, "electron/bundle");

function copyDir(src: string, dest: string): void {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log("Assembling bundle for packaging...");

// Start fresh
if (fs.existsSync(BUNDLE)) {
  fs.rmSync(BUNDLE, { recursive: true, force: true });
}

// Server: copy package.json, run clean production install, then copy dist
const serverBundle = path.join(BUNDLE, "server");
fs.mkdirSync(serverBundle, { recursive: true });
fs.copyFileSync(path.join(ROOT, "server/package.json"), path.join(serverBundle, "package.json"));

console.log("Installing server production dependencies...");
execSync("npm install --omit=dev", { cwd: serverBundle, stdio: "inherit" });

// Remove macOS quarantine from ffmpeg binary
const ffmpegBin = path.join(serverBundle, "node_modules", "ffmpeg-static", "ffmpeg");
if (fs.existsSync(ffmpegBin)) {
  try { execSync(`xattr -dr com.apple.quarantine "${ffmpegBin}"`, { stdio: "ignore" }); } catch {}
  try { execSync(`chmod +x "${ffmpegBin}"`, { stdio: "ignore" }); } catch {}
  console.log(`ffmpeg binary ready: ${ffmpegBin}`);
}

copyDir(path.join(ROOT, "server/dist"), path.join(serverBundle, "dist"));

// Client: dist, public, remotion source
copyDir(path.join(ROOT, "client/dist"), path.join(BUNDLE, "client/dist"));
copyDir(path.join(ROOT, "client/public"), path.join(BUNDLE, "client/public"));
copyDir(path.join(ROOT, "client/src/remotion"), path.join(BUNDLE, "client/src/remotion"));

// Shared types
copyDir(path.join(ROOT, "shared"), path.join(BUNDLE, "shared"));

console.log("Bundle assembled.");
```

**Step 2: Verify the script runs**

Run: `cd /Users/atti/Source/Repos/lusk && npm run build && cd electron && npx tsx scripts/bundle.ts`
Expected: "Bundle assembled." with `electron/bundle/` containing server/, client/, shared/.

**Step 3: Commit**

```bash
git add electron/scripts/bundle.ts
git commit -m "feat: add bundle assembly script for electron-builder"
```

---

### Task 3: Create electron-builder configuration

**Files:**
- Create: `electron/electron-builder.config.ts`

**Step 1: Write the config**

```typescript
import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "com.lusk.app",
  productName: "Lusk",
  directories: {
    output: "out",
    buildResources: "resources",
  },
  files: [
    "dist/**/*",
    "package.json",
  ],
  extraResources: [
    {
      from: "bundle",
      to: "bundle",
      filter: ["**/*"],
    },
  ],
  asar: false,
  mac: {
    category: "public.app-category.video",
    icon: "resources/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    identity: null,
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Lusk Project",
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Owner",
          CFBundleTypeExtensions: ["lusk"],
          CFBundleTypeIconFile: "icon.icns",
          LSItemContentTypes: ["com.lusk.project"],
        },
      ],
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: "com.lusk.project",
          UTTypeDescription: "Lusk Project",
          UTTypeConformsTo: ["public.data", "public.archive"],
          UTTypeTagSpecification: {
            "public.filename-extension": ["lusk"],
          },
          UTTypeIconFile: "icon.icns",
        },
      ],
    },
  },
  dmg: {
    icon: "resources/icon.icns",
    iconSize: 128,
    window: { width: 540, height: 380 },
    background: "resources/dmg-background.png",
  },
  publish: {
    provider: "github",
    releaseType: "release",
  },
};

export default config;
```

Note: `publish.provider: "github"` automatically uses the `repository` field from package.json or the git remote. The `owner` and `repo` are inferred. You will need to add a `"repository"` field to `electron/package.json` later (e.g., `"repository": "github:youruser/lusk"`).

**Step 2: Commit**

```bash
git add electron/electron-builder.config.ts
git commit -m "feat: add electron-builder configuration"
```

---

### Task 4: Update root package.json scripts

**Files:**
- Modify: `package.json` (root)

**Step 1: Update scripts**

Replace the root `package.json` scripts section:

```json
{
  "scripts": {
    "dev": "npm run dev --workspace=server & npm run dev --workspace=client",
    "dev:server": "npm run dev --workspace=server",
    "dev:client": "npm run dev --workspace=client",
    "dev:electron": "npm run build:electron && npm run start -w @lusk/electron",
    "build": "npm run build -w shared && npm run build -w server && npm run build -w client",
    "build:electron": "npm run build && npm run build -w @lusk/electron",
    "package": "npm run build:electron && npm run dist -w @lusk/electron",
    "release": "npm run build:electron && npm run release -w @lusk/electron"
  }
}
```

Changes: `package` now calls `dist` (local build, no publish). New `release` script calls `release` (build + publish to GitHub Releases).

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat: update root scripts for electron-builder"
```

---

### Task 5: Add auto-updater to Electron main process

**Files:**
- Modify: `electron/src/main.ts`

**Step 1: Add auto-updater imports and logic**

At the top of `electron/src/main.ts`, add the import:

```typescript
import { autoUpdater } from "electron-updater";
```

Add the clipboard import to the existing electron import:

```typescript
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from "electron";
```

Add this function after the `killServer` function (around line 211):

```typescript
function setupAutoUpdater(): void {
  // Disable auto-download — we want to prompt the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", async (info) => {
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Available",
      message: `A new version (${info.version}) is available.`,
      detail: "Would you like to download it now? The update will be installed when you restart.",
      buttons: ["Download", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on("update-downloaded", async () => {
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Ready",
      message: "Update has been downloaded.",
      detail: "Restart now to apply the update?",
      buttons: ["Restart", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
  });

  // Check for updates silently
  autoUpdater.checkForUpdates().catch((err) => {
    console.log("Update check failed (offline?):", err.message);
  });
}
```

**Step 2: Add dependency check function**

Add this function after `setupAutoUpdater`:

```typescript
async function checkDependencies(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    const health = (await res.json()) as { whisperxAvailable: boolean };

    if (!health.whisperxAvailable && mainWindow) {
      const commands = "brew install python3\npip3 install whisperx";
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Missing Dependencies",
        message: "WhisperX is not installed",
        detail:
          "Lusk needs Python 3 and WhisperX for transcription.\n\n" +
          "Run these commands in Terminal:\n\n" +
          commands +
          "\n\nTranscription won't work until these are installed.\n" +
          "You can still use Lusk for editing and rendering.",
        buttons: ["Copy Commands to Clipboard", "Continue"],
        defaultId: 0,
      });
      if (response === 0) {
        clipboard.writeText(commands);
      }
    }
  } catch {
    // Health check failed — server may still be starting, skip silently
  }
}
```

**Step 3: Wire up in app.whenReady**

In the `app.whenReady().then(async () => { ... })` block, after `createWindow();` (line 253), add:

```typescript
  // Check for updates (only in packaged app — dev builds have no publish config)
  if (app.isPackaged) {
    setupAutoUpdater();
  }

  // Check for missing dependencies after window loads
  mainWindow!.webContents.once("did-finish-load", async () => {
    await checkDependencies();
  });
```

Note: Move the existing `did-finish-load` handler (lines 229-233) into this new one, so there is only one handler:

```typescript
  mainWindow!.webContents.once("did-finish-load", async () => {
    if (pendingFilePath) {
      openLuskFile(pendingFilePath).catch(console.error);
      pendingFilePath = null;
    }
    await checkDependencies();
  });
```

Then remove the duplicate `did-finish-load` handler from inside `createWindow()`.

**Step 4: Add "Check for Updates" menu item**

Update the macOS menu template (around line 257) to include an update check:

```typescript
  if (process.platform === "darwin") {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about" as const },
          { type: "separator" as const },
          {
            label: "Check for Updates…",
            click: () => {
              autoUpdater.checkForUpdatesAndNotify().catch(console.error);
            },
          },
          { type: "separator" as const },
          { role: "quit" as const },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
```

**Step 5: Commit**

```bash
git add electron/src/main.ts
git commit -m "feat: add auto-updater and dependency check dialog"
```

---

### Task 6: Add repository field for GitHub publish

**Files:**
- Modify: `electron/package.json`

**Step 1: Add repository field**

Add to `electron/package.json` at the top level:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/OWNER/lusk.git"
}
```

Replace `OWNER` with the actual GitHub username/org. This is required for `electron-updater` to know where to check for releases.

**Step 2: Commit**

```bash
git add electron/package.json
git commit -m "feat: add repository field for auto-updater"
```

---

### Task 7: Add .gitignore entries for electron-builder output

**Files:**
- Modify: `.gitignore` (root)

**Step 1: Add entries**

Add to `.gitignore`:

```
# Electron builder
electron/bundle/
electron/out/
```

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore electron-builder output"
```

---

### Task 8: Test the full build pipeline

**Step 1: Build everything**

Run: `cd /Users/atti/Source/Repos/lusk && npm run package`

Expected: `electron/out/` contains:
- `Lusk-1.0.0-arm64.dmg`
- `Lusk-1.0.0-arm64-mac.zip`
- `latest-mac.yml`

**Step 2: Test the packaged app**

Open the DMG, drag Lusk to Applications (or run from the DMG), verify:
1. App launches
2. Server starts (video upload works)
3. Dependency dialog appears if WhisperX is missing
4. "Check for Updates" menu item exists under Lusk menu

**Step 3: Test the dev electron flow**

Run: `cd /Users/atti/Source/Repos/lusk && npm run dev:electron`

Expected: Electron window opens, loads the app from localhost:3000.

---

### Task 9: Test a release (dry run)

**Step 1: Bump version**

Run: `cd /Users/atti/Source/Repos/lusk/electron && npm version patch`

Expected: `electron/package.json` version becomes `1.0.1`, git commit and tag `v1.0.1` created.

**Step 2: Build for release (dry run without publishing)**

Run: `cd /Users/atti/Source/Repos/lusk && npm run package`

Verify the output files reference version `1.0.1`.

**Step 3: When ready to publish for real**

```bash
# Set GitHub token (create at github.com/settings/tokens with repo scope)
export GH_TOKEN=ghp_yourtoken

# Build and publish to GitHub Releases
npm run release
```

This creates a GitHub Release tagged `v1.0.1` with the DMG, ZIP, and `latest-mac.yml` attached.

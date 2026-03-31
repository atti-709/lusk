import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "../..");
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

// Remove macOS quarantine from Remotion compositor binaries (ffmpeg, ffprobe, remotion)
for (const arch of ["arm64", "x64"]) {
  const compositorDir = path.join(serverBundle, "node_modules", "@remotion", `compositor-darwin-${arch}`);
  if (fs.existsSync(compositorDir)) {
    for (const bin of ["ffmpeg", "ffprobe", "remotion"]) {
      const binPath = path.join(compositorDir, bin);
      if (fs.existsSync(binPath)) {
        try { execSync(`xattr -dr com.apple.quarantine "${binPath}"`, { stdio: "ignore" }); } catch {}
        try { execSync(`chmod +x "${binPath}"`, { stdio: "ignore" }); } catch {}
      }
    }
    console.log(`Remotion compositor binaries ready: ${compositorDir}`);
  }
}

copyDir(path.join(ROOT, "server/dist"), path.join(serverBundle, "dist"));

// Copy WhisperX requirements for PythonEnvService
fs.copyFileSync(
  path.join(ROOT, "server/requirements-whisperx.txt"),
  path.join(serverBundle, "requirements-whisperx.txt"),
);

// Client: dist, public, full src, and node_modules for Remotion bundler
copyDir(path.join(ROOT, "client/dist"), path.join(BUNDLE, "client/dist"));
copyDir(path.join(ROOT, "client/public"), path.join(BUNDLE, "client/public"));
copyDir(path.join(ROOT, "client/src"), path.join(BUNDLE, "client/src"));

// Client deps: Remotion webpack bundler needs @remotion/captions, @remotion/google-fonts, etc.
// These are client-only deps not in server/package.json.
const clientBundle = path.join(BUNDLE, "client");
fs.copyFileSync(path.join(ROOT, "client/package.json"), path.join(clientBundle, "package.json"));
console.log("Installing client production dependencies...");
execSync("npm install --omit=dev", { cwd: clientBundle, stdio: "inherit" });

// Shared types
copyDir(path.join(ROOT, "shared"), path.join(BUNDLE, "shared"));

// Copy @lusk/shared into client/node_modules so Remotion's webpack bundler can resolve it
// (npm workspace symlinks don't exist in the packaged bundle)
const luskScope = path.join(clientBundle, "node_modules", "@lusk");
fs.mkdirSync(luskScope, { recursive: true });
copyDir(path.join(BUNDLE, "shared"), path.join(luskScope, "shared"));

console.log("Bundle assembled.");

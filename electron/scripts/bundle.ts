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

copyDir(path.join(ROOT, "server/dist"), path.join(serverBundle, "dist"));

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

console.log("Bundle assembled.");

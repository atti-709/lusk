import type { ForgeConfig } from "@electron-forge/shared-types";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// Root of the monorepo (one level up from electron/)
const ROOT = path.resolve(__dirname, "..");

function copyDir(src: string, dest: string): void {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Lusk",
    appBundleId: "com.lusk.app",
    icon: "./resources/icon",
    asar: false, // Server needs real filesystem access (ffmpeg, WhisperX, Remotion bundler)
    // Only include the compiled app and its runtime deps in the .app bundle.
    // Without this, electron-packager copies the entire electron/ directory including
    // bundle/ (already in extraResource), out/ (old builds), and source files.
    ignore: (filePath: string) => {
      if (!filePath) return false;
      if (filePath === "/package.json") return false;
      if (filePath.startsWith("/dist")) return false;
      if (filePath.startsWith("/node_modules")) return false;
      return true;
    },
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Lusk Project",
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Owner",
          CFBundleTypeExtensions: ["lusk"],
          CFBundleTypeIconFile: "icon",
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
          UTTypeIconFile: "icon",
        },
      ],
    },
    // Single extraResource so basenames never conflict
    extraResource: ["./bundle"],
  },
  hooks: {
    prePackage: async () => {
      const bundleDir = path.join(__dirname, "bundle");
      console.log("Assembling bundle for packaging...");

      // Start fresh
      if (fs.existsSync(bundleDir)) {
        fs.rmSync(bundleDir, { recursive: true, force: true });
      }

      // Server: copy package.json, run a clean production npm install, then copy dist.
      // Cannot just copy server/node_modules — npm workspaces hoist most packages to
      // the root node_modules, so server/node_modules is nearly empty.
      const serverBundleDir = `${bundleDir}/server`;
      fs.mkdirSync(serverBundleDir, { recursive: true });
      fs.copyFileSync(`${ROOT}/server/package.json`, `${serverBundleDir}/package.json`);
      console.log("Installing server production dependencies (this may take a minute)...");
      execSync("npm install --omit=dev", { cwd: serverBundleDir, stdio: "inherit" });
      copyDir(`${ROOT}/server/dist`, `${serverBundleDir}/dist`);

      // client/dist, client/public, client/src/remotion
      // Note: client/node_modules is NOT copied — it only contains build caches (.cache, .vite)
      // and a few types packages. Remotion's webpack bundler resolves modules from
      // server/node_modules via the webpackOverride in RenderService.
      copyDir(`${ROOT}/client/dist`, `${bundleDir}/client/dist`);
      copyDir(`${ROOT}/client/public`, `${bundleDir}/client/public`);
      copyDir(`${ROOT}/client/src/remotion`, `${bundleDir}/client/src/remotion`);

      // shared types
      copyDir(`${ROOT}/shared`, `${bundleDir}/shared`);

      console.log("Bundle assembled.");
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
        background: "./resources/dmg-background.png",
        iconSize: 128,
        // electron-installer-dmg only passes specific keys to appdmg;
        // window must go through additionalDMGOptions.
        additionalDMGOptions: {
          window: { size: { width: 540, height: 380 } },
        },
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
  ],
};

export default config;

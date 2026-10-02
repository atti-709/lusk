import { test as base, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { launchLusk, type Lusk } from "./harness";

export const FIXTURES_DIR = path.join(__dirname, ".fixtures");

/** A short synthetic 16:9 clip (test pattern + tone), generated once via ffmpeg. */
export function sampleVideo(): string {
  const out = path.join(FIXTURES_DIR, "sample.mp4");
  if (!existsSync(out)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
    ]);
  }
  return out;
}

export const test = base.extend<{ lusk: Lusk }>({
  lusk: async ({}, use, testInfo) => {
    const lusk = await launchLusk();
    await use(lusk);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("app-logs", { body: lusk.logs.join(""), contentType: "text/plain" });
      await testInfo.attach("screenshot", {
        body: await lusk.window.screenshot().catch(() => Buffer.alloc(0)),
        contentType: "image/png",
      });
    }
    await lusk.close();
  },
});

export { expect };

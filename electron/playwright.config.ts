import { defineConfig } from "@playwright/test";

// Each test launches its own Electron instance (own port + temp profile),
// but WhisperX/Remotion are heavy, so keep runs serial.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./test-results",
  use: { trace: "retain-on-failure" },
});

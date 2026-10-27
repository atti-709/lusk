import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, sampleVideo, test } from "./fixtures";
import { launchLusk } from "./harness";

test("app boots to the dashboard with a healthy server", async ({ lusk }) => {
  const health = await lusk.api<{ status?: string }>("/api/health");
  expect(health).toBeTruthy();

  const { window } = lusk;
  await expect(window.getByRole("button", { name: "Open Project..." })).toBeVisible();
  expect(await window.evaluate(() => (window as any).lusk?.isElectron)).toBe(true);
});

test("new project → select video via native dialogs", async ({ lusk }) => {
  const { window } = lusk;
  const projectPath = path.join(lusk.userDataDir, "e2e-project.lusk");
  await lusk.stubSaveDialog(projectPath);
  await lusk.stubOpenDialog(sampleVideo());

  const newProject = window.getByRole("button", { name: "+ New Project" });
  test.skip(await newProject.isDisabled(), "WhisperX not available in this environment");
  await newProject.click();

  // The language is asked at creation, defaults to the Settings language (sk) and is stored in the .lusk
  const language = window.getByLabel("Spoken language");
  await expect(language).toHaveValue("sk");
  await language.selectOption("cs");
  await window.getByTestId("new-project-create").click();
  const stored = JSON.parse(execFileSync("unzip", ["-p", projectPath, "project.json"], { encoding: "utf-8" }));
  expect(stored.language).toBe("cs");

  await expect(window.getByRole("heading", { name: "Add a source video" })).toBeVisible();
  await window.getByRole("button", { name: "Browse files" }).click();
  await expect(window.getByText("sample.mp4")).toBeVisible();
  await expect(window.getByRole("button", { name: "Start" })).toBeVisible();
});

test("falls back to a free port when the preferred one is taken", async () => {
  // Hold the port on IPv6 only — like another dev server on [::]:3000, which
  // `localhost` resolves to before 127.0.0.1.
  const blocker = createServer((_req, res) => res.writeHead(418).end());
  await new Promise<void>((resolve) => blocker.listen(0, "::", resolve));
  const takenPort = (blocker.address() as AddressInfo).port;
  const lusk = await launchLusk({ env: { LUSK_PORT: String(takenPort) } });
  try {
    expect(lusk.port).not.toBe(takenPort);
    expect(await lusk.api<{ status: string }>("/api/health")).toMatchObject({ status: "ok" });
    await expect(lusk.window.getByRole("button", { name: "Open Project..." })).toBeVisible();
  } finally {
    await lusk.close();
    blocker.close();
  }
});

test("Settings: 'Translate captions to English' is off by default and toggles", async ({ lusk }) => {
  const { window } = lusk;
  await window.getByTitle("Settings").click();
  const box = window.getByLabel("Translate captions to English");
  await expect(box).not.toBeChecked();
  await box.check();
  await window.getByRole("button", { name: "Save" }).click();
  await expect(window.getByText("Saved")).toBeVisible();
  expect((await lusk.api<{ translateToEnglish: boolean }>("/api/settings")).translateToEnglish).toBe(true);
  await box.uncheck();
  await window.getByRole("button", { name: "Save" }).click();
  await expect(window.getByText("Saved")).toBeVisible();
  expect((await lusk.api<{ translateToEnglish: boolean }>("/api/settings")).translateToEnglish).toBe(false);
});

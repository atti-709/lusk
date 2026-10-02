import path from "node:path";
import { expect, sampleVideo, test } from "./fixtures";

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

  await expect(window.getByRole("heading", { name: "Add a source video" })).toBeVisible();
  await window.getByRole("button", { name: "Browse files" }).click();
  await expect(window.getByText("sample.mp4")).toBeVisible();
  await expect(window.getByRole("button", { name: "Start" })).toBeVisible();
});

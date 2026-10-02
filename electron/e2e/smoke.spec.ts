import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

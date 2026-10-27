import { expect, test } from "@playwright/test";
import { launchLusk } from "./harness";

test("headless: the API answers and no window exists", async () => {
  const lusk = await launchLusk({ headless: true });
  try {
    expect(lusk.window).toBeNull();
    expect(await lusk.api<{ status: string }>("/api/health")).toMatchObject({ status: "ok" });
    expect(lusk.app.windows()).toHaveLength(0);
    const state = await lusk.app.evaluate(({ BrowserWindow, app }) => ({
      windows: BrowserWindow.getAllWindows().length,
      dockVisible: app.dock?.isVisible() ?? false,
    }));
    expect(state.windows).toBe(0);
    expect(state.dockVisible).toBe(false);
    // Still alive a moment later: no window-all-closed quit
    await new Promise((r) => setTimeout(r, 1500));
    expect(await lusk.api<{ status: string }>("/api/health")).toMatchObject({ status: "ok" });
  } finally {
    await lusk.close();
  }
});

test("headless: a Python env that is not ready exits non-zero with a message", async () => {
  await expect(
    launchLusk({
      headless: true,
      reusePythonEnv: false,
      env: { LUSK_PYTHON_ENV_DIR: "/nonexistent/lusk-python-env" },
    }),
  ).rejects.toThrow(/Python env not ready/);
});

import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "./fixtures";

test("new project: Sermon profile and Advanced clip settings persist in the .lusk and after reopening", async ({ lusk }) => {
  const { window } = lusk;
  const projectPath = path.join(lusk.userDataDir, "e2e-sermon.lusk");
  await lusk.stubSaveDialog(projectPath);

  const newProject = window.getByRole("button", { name: "+ New Project" });
  test.skip(await newProject.isDisabled(), "WhisperX not available in this environment");
  await newProject.click();

  const profile = window.getByLabel("Content type");
  await expect(profile).toHaveValue("podcast");
  await profile.selectOption("sermon");
  await window.getByTestId("new-project-advanced").click();
  await window.getByLabel("Min length (s)").fill("35");
  await window.getByLabel("Max length (s)").fill("55");
  await window.getByLabel("Clips (max)").fill("8");
  await window.getByLabel("Selection instructions").fill("Only clips about forgiveness.");
  // LUSK_E2E_SHOT=/path.png keeps a picture of the dialog for review
  if (process.env.LUSK_E2E_SHOT) await window.screenshot({ path: process.env.LUSK_E2E_SHOT });
  await window.getByTestId("new-project-create").click();

  const read = () => JSON.parse(execFileSync("unzip", ["-p", projectPath, "project.json"], { encoding: "utf-8" }));
  const expected = { minSec: 35, maxSec: 55, count: 8, instructions: "Only clips about forgiveness." };
  expect(read().contentProfile).toBe("sermon");
  expect(read().clipSettings).toEqual(expected);

  // Reopen from disk: the profile comes back with the project
  const opened = await lusk.api<{ projectId: string }>("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath }),
  });
  const state = await lusk.api<{ contentProfile: string; clipSettings: unknown }>(`/api/projects/${opened.projectId}`);
  expect(state.contentProfile).toBe("sermon");
  expect(state.clipSettings).toEqual(expected);
});

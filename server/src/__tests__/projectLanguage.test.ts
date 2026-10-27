import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import Fastify, { type FastifyInstance } from "fastify";
import { parseProjectLanguage } from "@lusk/shared";

// The registry/config dir is read when a service is used, so isolate it before importing them
const root = mkdtempSync(join(tmpdir(), "lusk-lang-"));
process.env.LUSK_REGISTRY_DIR = join(root, "registry");
process.env.LUSK_TEMP_DIR = join(root, "temp");

const { projectsRoute } = await import("../routes/projects.js");
const { alignRoute } = await import("../routes/align.js");
const { orchestrator } = await import("../services/Orchestrator.js");
const { settingsService } = await import("../services/SettingsService.js");

function readProjectJson(path: string): Record<string, unknown> {
  return JSON.parse(new AdmZip(path).readAsText("project.json"));
}

function stripLanguage(path: string): void {
  const data = readProjectJson(path);
  delete data.language;
  const zip = new AdmZip();
  zip.addFile("project.json", Buffer.from(JSON.stringify(data), "utf-8"));
  zip.writeZip(path);
}

describe("project language", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(projectsRoute);
    await app.register(alignRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = async (name: string, language?: string) => {
    const projectPath = join(root, `${name}.lusk`);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/create",
      payload: { projectPath, ...(language ? { language } : {}) },
    });
    expect(res.statusCode).toBe(200);
    return { projectPath, projectId: res.json().projectId as string };
  };

  it("parseProjectLanguage falls back for anything unsupported", () => {
    expect(parseProjectLanguage("cs")).toBe("cs");
    expect(parseProjectLanguage("de")).toBe("sk");
    expect(parseProjectLanguage(undefined, "en")).toBe("en");
  });

  it("stores the language chosen at creation in the .lusk", async () => {
    const { projectPath, projectId } = await create("chosen", "cs");
    expect(readProjectJson(projectPath).language).toBe("cs");
    expect(orchestrator.getSession(projectId)?.language).toBe("cs");
  });

  it("takes the Settings language as the default for a new project only", async () => {
    await settingsService.save({ transcriptionLanguage: "en" });
    const { projectPath } = await create("defaulted");
    expect(readProjectJson(projectPath).language).toBe("en");

    await settingsService.save({ transcriptionLanguage: "sk" });
    expect(readProjectJson(projectPath).language).toBe("en");
  });

  it("opens a project saved before the language existed as sk", async () => {
    const { projectPath } = await create("old", "cs");
    stripLanguage(projectPath);
    expect(readProjectJson(projectPath).language).toBeUndefined();

    await settingsService.save({ transcriptionLanguage: "cs" });
    const res = await app.inject({ method: "POST", url: "/api/projects/open", payload: { projectPath } });
    expect(res.statusCode).toBe(200);
    expect(orchestrator.getSession(res.json().projectId)?.language).toBe("sk");
  });

  it("exports the SRT in the project's language whatever the default is now", async () => {
    await settingsService.save({ transcriptionLanguage: "sk" });
    const { projectId } = await create("srt", "sk");
    orchestrator.setCaptions(projectId, [
      { text: "Dobrý", startMs: 0, endMs: 400, timestampMs: null, confidence: 1 },
      { text: "deň", startMs: 400, endMs: 800, timestampMs: null, confidence: 1 },
      { text: "prajem", startMs: 800, endMs: 1300, timestampMs: null, confidence: 1 },
    ]);

    const before = await app.inject({ method: "GET", url: `/api/projects/${projectId}/captions.srt` });
    await settingsService.save({ transcriptionLanguage: "cs" });
    const after = await app.inject({ method: "GET", url: `/api/projects/${projectId}/captions.srt` });

    expect(before.statusCode).toBe(200);
    expect(before.headers["content-disposition"]).toContain("captions_sk.srt");
    expect(after.headers["content-disposition"]).toBe(before.headers["content-disposition"]);
    expect(after.body).toBe(before.body);
  });
});

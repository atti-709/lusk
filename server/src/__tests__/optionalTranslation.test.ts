import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

// The config dir is read when the settings are used, so isolate it before importing the services
const root = mkdtempSync(join(tmpdir(), "lusk-translate-"));
process.env.LUSK_REGISTRY_DIR = join(root, "registry");
process.env.LUSK_TEMP_DIR = join(root, "temp");

const { runGeminiAutomation, transcribeRoute } = await import("../routes/transcribe.js");
const { alignRoute } = await import("../routes/align.js");
const { settingsRoute } = await import("../routes/settings.js");
const { orchestrator } = await import("../services/Orchestrator.js");
const { settingsService } = await import("../services/SettingsService.js");
const { geminiService } = await import("../services/GeminiService.js");

const WORDS = ["Dobrý", "deň", "vítam", "vás", "pri", "dnešnej", "epizóde", "podcastu."].map((word, i) => ({
  word,
  startMs: i * 400,
  endMs: i * 400 + 350,
}));

const log = { error: () => {} };
let n = 0;

/** A session with transcribed words, run through the Gemini automation with Gemini stubbed. */
async function runAutomation(): Promise<string> {
  const id = `t18-${++n}`;
  orchestrator.createSession(id, "/v.mp4");
  orchestrator.transition(id, "TRANSCRIBING");
  orchestrator.transition(id, "ALIGNING");
  await runGeminiAutomation(id, { words: WORDS }, log);
  return id;
}

describe("optional English translation", () => {
  let app: FastifyInstance;
  const translate = vi.spyOn(geminiService, "translateCaptions");

  beforeAll(async () => {
    vi.spyOn(geminiService, "proofreadTranscript").mockImplementation(async (words: any) => ({ words, applied: [], rejected: [] }) as any);
    vi.spyOn(geminiService, "detectViralClips").mockResolvedValue([] as any);
    app = Fastify();
    await app.register(transcribeRoute);
    await app.register(alignRoute);
    await app.register(settingsRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    translate.mockReset();
    translate.mockImplementation(async (blocks: any[]) => blocks.map((_b, i) => `line ${i}`));
    await settingsService.save({});
  });

  it("is off by default", async () => {
    expect(await settingsService.getTranslateToEnglish()).toBe(false);
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.json().translateToEnglish).toBe(false);
  });

  it("skips translation in the pipeline when off", async () => {
    const id = await runAutomation();
    expect(translate).not.toHaveBeenCalled();
    expect(orchestrator.getSession(id)?.translatedCaptions).toBeNull();
    expect(orchestrator.getSession(id)?.state).toBe("READY");
  });

  it("translates in the pipeline when on", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/settings", payload: { translateToEnglish: true } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().translateToEnglish).toBe(true);

    const id = await runAutomation();
    expect(translate).toHaveBeenCalledOnce();
    expect(orchestrator.getSession(id)?.translatedCaptions?.length).toBeGreaterThan(0);
    expect(orchestrator.getSession(id)?.state).toBe("READY");
  });

  it("answers the translate route with 409 when off and translates when on", async () => {
    const id = await runAutomation();
    const off = await app.inject({ method: "POST", url: `/api/projects/${id}/translate` });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toMatch(/Settings/);
    expect(translate).not.toHaveBeenCalled();

    await settingsService.save({ translateToEnglish: true });
    const on = await app.inject({ method: "POST", url: `/api/projects/${id}/translate` });
    expect(on.statusCode).toBe(200);
    expect(translate).toHaveBeenCalledOnce();
  });

  it("still exports the English SRT of a project that has a translation while off", async () => {
    const id = "t18-existing";
    orchestrator.createSession(id, "/v.mp4");
    orchestrator.setTranslatedCaptions(id, [{ text: "Hello and welcome", startMs: 0, endMs: 2000 }]);
    expect(await settingsService.getTranslateToEnglish()).toBe(false);
    const res = await app.inject({ method: "GET", url: `/api/projects/${id}/captions-en.srt` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Hello and welcome");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lusk-arbiter-optin-"));
process.env.LUSK_REGISTRY_DIR = join(root, "registry");
process.env.LUSK_TEMP_DIR = join(root, "temp");
delete process.env.LUSK_WHISPER_MODEL;

const { WhisperService } = await import("../services/WhisperService.js");
const { settingsService } = await import("../services/SettingsService.js");
const { geminiService } = await import("../services/GeminiService.js");

/** The arbiter is off by default and needs the setting, a language fine-tune and a key: otherwise the fine-tune's text goes through as today. */
describe("when the two-model arbiter runs", () => {
  const use = (language: string) => (new WhisperService() as any).useArbiter(language) as Promise<boolean>;
  beforeEach(async () => {
    await settingsService.save({});
    vi.spyOn(geminiService, "isAvailable").mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("is off by default", async () => {
    expect(await settingsService.getTwoModelArbiter()).toBe(false);
    expect(await use("sk")).toBe(false);
  });

  it("runs for a language with a fine-tune when the setting is on and there is a key", async () => {
    await settingsService.save({ twoModelArbiter: true });
    expect(await use("sk")).toBe(true);
    expect(await use("cs")).toBe(true);
  });

  it("no key: the fine-tune's text as today", async () => {
    await settingsService.save({ twoModelArbiter: true });
    vi.spyOn(geminiService, "isAvailable").mockResolvedValue(false);
    expect(await use("sk")).toBe(false);
  });

  it("a language without a fine-tune has no second model", async () => {
    await settingsService.save({ twoModelArbiter: true });
    expect(await use("en")).toBe(false);
  });

  it("a LUSK_WHISPER_MODEL comparison run is a one-model run", async () => {
    await settingsService.save({ twoModelArbiter: true });
    process.env.LUSK_WHISPER_MODEL = "some/model";
    try {
      expect(await use("sk")).toBe(false);
    } finally {
      delete process.env.LUSK_WHISPER_MODEL;
    }
  });
});

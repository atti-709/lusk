import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getClientPublicDir } from "../config/paths.js";

export type TranscriptionLanguage = "sk" | "cs" | "en";

export interface AppSettings {
  geminiApiKey?: string;
  transcriptionLanguage?: TranscriptionLanguage;
  correctionPrompt?: string;
  viralClipsPrompt?: string;
  fps?: number;
  outroOverlapFrames?: number;
}

export function getConfigDir(): string {
  return process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

class SettingsService {
  private cache: AppSettings | null = null;

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(getConfigPath(), "utf-8");
      this.cache = JSON.parse(raw) as AppSettings;
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  async save(settings: AppSettings): Promise<void> {
    const configPath = getConfigPath();
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2), "utf-8");
    this.cache = settings;
  }

  async getGeminiApiKey(): Promise<string | null> {
    // Env var takes precedence
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    const settings = await this.load();
    return settings.geminiApiKey ?? null;
  }

  async getTranscriptionLanguage(): Promise<TranscriptionLanguage> {
    const settings = await this.load();
    return settings.transcriptionLanguage ?? "sk";
  }

  async getCorrectionPrompt(): Promise<string> {
    const settings = await this.load();
    if (settings.correctionPrompt) return settings.correctionPrompt;
    return this.getDefaultCorrectionPrompt();
  }

  async getViralClipsPrompt(): Promise<string> {
    const settings = await this.load();
    if (settings.viralClipsPrompt) return settings.viralClipsPrompt;
    return this.getDefaultViralClipsPrompt();
  }

  async getDefaultCorrectionPrompt(): Promise<string> {
    const promptPath = join(getClientPublicDir(), "prompts", "correction-api.md");
    return readFile(promptPath, "utf-8");
  }

  async getDefaultViralClipsPrompt(): Promise<string> {
    const promptPath = join(getClientPublicDir(), "prompts", "viral-clips-api.md");
    return readFile(promptPath, "utf-8");
  }

  async getFps(): Promise<number> {
    const settings = await this.load();
    return settings.fps ?? 23.976;
  }

  async getOutroOverlapFrames(): Promise<number> {
    const settings = await this.load();
    return settings.outroOverlapFrames ?? 4;
  }
}

export const settingsService = new SettingsService();

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AppSettings {
  geminiApiKey?: string;
}

function getConfigPath(): string {
  return join(process.env.LUSK_REGISTRY_DIR ?? join(homedir(), ".lusk"), "config.json");
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
}

export const settingsService = new SettingsService();

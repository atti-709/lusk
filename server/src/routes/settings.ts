import type { FastifyPluginAsync } from "fastify";
import { settingsService } from "../services/SettingsService.js";

export const settingsRoute: FastifyPluginAsync = async (server) => {
  server.get("/api/settings", async () => {
    const settings = await settingsService.load();
    // Mask the API key for the client — only send whether it's configured
    return {
      geminiApiKeySet: !!(settings.geminiApiKey || process.env.GEMINI_API_KEY),
      transcriptionLanguage: settings.transcriptionLanguage ?? "sk",
      correctionPrompt: settings.correctionPrompt ?? null,
      viralClipsPrompt: settings.viralClipsPrompt ?? null,
    };
  });

  server.get("/api/settings/default-prompts", async () => {
    const [correctionPrompt, viralClipsPrompt] = await Promise.all([
      settingsService.getDefaultCorrectionPrompt(),
      settingsService.getDefaultViralClipsPrompt(),
    ]);
    return { correctionPrompt, viralClipsPrompt };
  });

  server.put<{
    Body: {
      geminiApiKey?: string;
      transcriptionLanguage?: string;
      correctionPrompt?: string | null;
      viralClipsPrompt?: string | null;
    };
  }>("/api/settings", async (request) => {
    const current = await settingsService.load();
    const { geminiApiKey, transcriptionLanguage, correctionPrompt, viralClipsPrompt } =
      request.body ?? {};

    if (geminiApiKey !== undefined) {
      current.geminiApiKey = geminiApiKey;
    }
    if (transcriptionLanguage !== undefined && ["sk", "cs", "en"].includes(transcriptionLanguage)) {
      current.transcriptionLanguage = transcriptionLanguage as "sk" | "cs" | "en";
    }
    // null = reset to default (delete from config), string = custom prompt
    if (correctionPrompt !== undefined) {
      current.correctionPrompt = correctionPrompt ?? undefined;
    }
    if (viralClipsPrompt !== undefined) {
      current.viralClipsPrompt = viralClipsPrompt ?? undefined;
    }

    await settingsService.save(current);
    return { success: true };
  });
};

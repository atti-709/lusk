import type { FastifyPluginAsync } from "fastify";
import { settingsService } from "../services/SettingsService.js";

export const settingsRoute: FastifyPluginAsync = async (server) => {
  server.get("/api/settings", async () => {
    const settings = await settingsService.load();
    // Mask the API key for the client — only send whether it's configured
    return {
      geminiApiKeySet: !!(settings.geminiApiKey || process.env.GEMINI_API_KEY),
      transcriptionLanguage: settings.transcriptionLanguage ?? "sk",
    };
  });

  server.put<{ Body: { geminiApiKey?: string; transcriptionLanguage?: string } }>(
    "/api/settings",
    async (request) => {
      const current = await settingsService.load();
      const { geminiApiKey, transcriptionLanguage } = request.body ?? {};

      if (geminiApiKey !== undefined) {
        current.geminiApiKey = geminiApiKey;
      }
      if (transcriptionLanguage !== undefined && ["sk", "cs", "en"].includes(transcriptionLanguage)) {
        current.transcriptionLanguage = transcriptionLanguage as "sk" | "cs" | "en";
      }

      await settingsService.save(current);
      return { success: true };
    }
  );
};

import type { FastifyPluginAsync } from "fastify";
import { settingsService } from "../services/SettingsService.js";

export const settingsRoute: FastifyPluginAsync = async (server) => {
  server.get("/api/settings", async () => {
    const settings = await settingsService.load();
    // Mask the API key for the client — only send whether it's configured
    return {
      geminiApiKeySet: !!(settings.geminiApiKey || process.env.GEMINI_API_KEY),
    };
  });

  server.put<{ Body: { geminiApiKey?: string } }>(
    "/api/settings",
    async (request) => {
      const current = await settingsService.load();
      const { geminiApiKey } = request.body ?? {};

      if (geminiApiKey !== undefined) {
        current.geminiApiKey = geminiApiKey;
      }

      await settingsService.save(current);
      return { success: true };
    }
  );
};

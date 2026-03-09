import type { FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import fs from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { settingsService, getConfigDir } from "../services/SettingsService.js";
import { getClientPublicDir } from "../config/paths.js";
import { renderService } from "../services/RenderService.js";

const VALID_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export const settingsRoute: FastifyPluginAsync = async (server) => {
  await server.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500 MB for outro videos
    },
  });
  server.get("/api/settings", async () => {
    const settings = await settingsService.load();

    // Check if outro exists in either location
    const globalOutro = path.join(getConfigDir(), "outro.mp4");
    const bundledOutro = path.join(getClientPublicDir(), "outro.mp4");
    const outroSet = fs.existsSync(globalOutro) || fs.existsSync(bundledOutro);

    // Mask the API key for the client — only send whether it's configured
    return {
      geminiApiKeySet: !!(settings.geminiApiKey || process.env.GEMINI_API_KEY),
      transcriptionLanguage: settings.transcriptionLanguage ?? "sk",
      correctionPrompt: settings.correctionPrompt ?? null,
      viralClipsPrompt: settings.viralClipsPrompt ?? null,
      fps: settings.fps ?? 23.976,
      outroOverlapFrames: settings.outroOverlapFrames ?? 4,
      outroSet,
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
      fps?: number;
      outroOverlapFrames?: number;
    };
  }>("/api/settings", async (request) => {
    const current = await settingsService.load();
    const { geminiApiKey, transcriptionLanguage, correctionPrompt, viralClipsPrompt, fps, outroOverlapFrames } =
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
    if (fps !== undefined && VALID_FPS.includes(fps)) {
      current.fps = fps;
    }
    if (outroOverlapFrames !== undefined) {
      const val = Math.round(outroOverlapFrames);
      if (Number.isInteger(val) && val >= 0 && val <= 30) {
        current.outroOverlapFrames = val;
      }
    }

    await settingsService.save(current);
    return { success: true };
  });

  // Upload outro video
  server.post("/api/settings/outro", async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ success: false, error: "No file uploaded" });
    }

    const configDir = getConfigDir();
    const outroPath = path.join(configDir, "outro.mp4");
    const writeStream = fs.createWriteStream(outroPath);
    await pipeline(data.file, writeStream);

    renderService.invalidateBundle();
    return { success: true };
  });

  // Delete outro video
  server.delete("/api/settings/outro", async () => {
    const outroPath = path.join(getConfigDir(), "outro.mp4");
    try {
      await unlink(outroPath);
    } catch {
      // File doesn't exist — that's fine
    }
    renderService.invalidateBundle();
    return { success: true };
  });
};

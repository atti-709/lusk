import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadResponse, ErrorResponse } from "@lusk/shared";
import { tempManager } from "../services/TempManager.js";
import { orchestrator } from "../services/Orchestrator.js";

export async function uploadRoute(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
    },
  });

  app.post<{ Reply: UploadResponse | ErrorResponse }>(
    "/api/upload",
    async (request, reply) => {
      let data;
      try {
        data = await request.file();
      } catch {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      if (!data) {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      const sessionId = tempManager.createSession();
      const sessionDir = await tempManager.ensureSessionDir(sessionId);

      const savePath = join(sessionDir, "input.mp4");
      await pipeline(data.file, createWriteStream(savePath));

      const videoUrl = `/static/${sessionId}/input.mp4`;

      orchestrator.createSession(sessionId, videoUrl);

      return {
        success: true as const,
        sessionId,
        fileName: "input.mp4",
        url: videoUrl,
      };
    }
  );
}

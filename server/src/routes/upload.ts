import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadResponse, ErrorResponse } from "@lusk/shared";

export const TEMP_DIR = join(import.meta.dirname, "../../.lusk_temp");

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

      const sessionId = randomUUID();
      const sessionDir = join(TEMP_DIR, sessionId);
      await mkdir(sessionDir, { recursive: true });

      const savePath = join(sessionDir, "input.mp4");
      await pipeline(data.file, createWriteStream(savePath));

      return {
        success: true as const,
        sessionId,
        fileName: "input.mp4",
        url: `/static/${sessionId}/input.mp4`,
      };
    }
  );
}

import { FastifyInstance } from "fastify";
import { tempManager } from "../services/TempManager.js";
import { orchestrator } from "../services/Orchestrator.js";
import type { SessionSummary } from "@lusk/shared";

export async function sessionsRoute(app: FastifyInstance) {
  app.get<{ Reply: SessionSummary[] }>(
    "/api/sessions",
    async () => {
      return tempManager.listSessions();
    }
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      const { sessionId } = request.params;
      const { rm } = await import("node:fs/promises");
      const dir = tempManager.getSessionDir(sessionId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Already gone
      }
      return { success: true };
    }
  );
}

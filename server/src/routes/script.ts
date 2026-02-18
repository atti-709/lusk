import { FastifyInstance } from "fastify";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { orchestrator } from "../services/Orchestrator.js";
import { tempManager } from "../services/TempManager.js";
import type { ErrorResponse } from "@lusk/shared";

interface ScriptBody {
  text: string;
}

export async function scriptRoute(app: FastifyInstance) {
  app.post<{
    Params: { sessionId: string };
    Body: ScriptBody;
    Reply: { success: true } | ErrorResponse;
  }>("/api/project/:sessionId/script", async (request, reply) => {
    const { sessionId } = request.params;
    const { text } = (request.body ?? {}) as Partial<ScriptBody>;

    if (!text || typeof text !== "string") {
      return reply
        .status(400)
        .send({ success: false, error: "text is required" });
    }

    const session = orchestrator.getSession(sessionId);
    if (!session) {
      return reply
        .status(404)
        .send({ success: false, error: "Session not found" });
    }

    orchestrator.setSourceScript(sessionId, text);

    // Save to session dir for debugging
    const sessionDir = tempManager.getSessionDir(sessionId);
    await writeFile(join(sessionDir, "source-script.txt"), text);

    return { success: true as const };
  });
}

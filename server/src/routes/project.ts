import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { ProjectState, ErrorResponse } from "@lusk/shared";

export async function projectRoute(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string }; Reply: ProjectState | ErrorResponse }>(
    "/api/project/:sessionId",
    async (request, reply) => {
      const { sessionId } = request.params;
      const state = orchestrator.toProjectState(sessionId);

      if (!state) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      return state;
    }
  );
}

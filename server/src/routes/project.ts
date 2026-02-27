import { FastifyInstance } from "fastify";
import { orchestrator } from "../services/Orchestrator.js";
import type { ProjectState, ErrorResponse } from "@lusk/shared";

export async function projectRoute(app: FastifyInstance) {
  app.get<{ Params: { projectId: string }; Reply: ProjectState | ErrorResponse }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const { projectId } = request.params;
      const state = orchestrator.toProjectState(projectId);

      if (!state) {
        return reply.status(404).send({ success: false, error: "Session not found" });
      }

      return state;
    }
  );
}

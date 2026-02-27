// Sessions routes have been replaced by /api/projects/* in projects.ts.
// This file is kept as an empty plugin to avoid breaking imports during migration.

import { FastifyInstance } from "fastify";

export async function sessionsRoute(_app: FastifyInstance) {
  // No routes — replaced by projectsRoute
}

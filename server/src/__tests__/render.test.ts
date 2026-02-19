import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { renderRoute } from "../routes/render.js";
import { orchestrator } from "../services/Orchestrator.js";

describe("POST /api/render", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(renderRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 400 when sessionId is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/render",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/sessionId/);
  });

  it("returns 404 for unknown session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/render",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: "nonexistent",
        clip: { title: "Test", startMs: 0, endMs: 30000, hookText: "hook" },
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 409 when session is not in READY state", async () => {
    orchestrator.createSession("render-409", "/v.mp4");

    const response = await app.inject({
      method: "POST",
      url: "/api/render",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: "render-409",
        clip: { title: "Test", startMs: 0, endMs: 30000, hookText: "hook" },
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 200 and starts render for valid session", async () => {
    orchestrator.createSession("render-ok", "/v.mp4");
    // Walk to READY state
    orchestrator.transition("render-ok", "TRANSCRIBING");
    orchestrator.transition("render-ok", "ALIGNING");
    orchestrator.transition("render-ok", "ANALYZING");
    orchestrator.transition("render-ok", "READY");

    const response = await app.inject({
      method: "POST",
      url: "/api/render",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: "render-ok",
        clip: { title: "Test", startMs: 0, endMs: 30000, hookText: "hook" },
        offsetX: 0,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });
});

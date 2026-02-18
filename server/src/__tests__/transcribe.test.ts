import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { transcribeRoute } from "../routes/transcribe.js";
import { orchestrator } from "../services/Orchestrator.js";

describe("POST /api/transcribe", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(transcribeRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 400 when sessionId is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/transcribe",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/sessionId/);
  });

  it("returns 404 for unknown session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/transcribe",
      headers: { "content-type": "application/json" },
      payload: { sessionId: "nonexistent" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 409 when session is not in UPLOADING state", async () => {
    orchestrator.createSession("transcribe-409", "/v.mp4");
    orchestrator.transition("transcribe-409", "TRANSCRIBING");

    const response = await app.inject({
      method: "POST",
      url: "/api/transcribe",
      headers: { "content-type": "application/json" },
      payload: { sessionId: "transcribe-409" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("returns 200 and starts transcription for valid session", async () => {
    orchestrator.createSession("transcribe-ok", "/v.mp4");

    const response = await app.inject({
      method: "POST",
      url: "/api/transcribe",
      headers: { "content-type": "application/json" },
      payload: { sessionId: "transcribe-ok" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });
});

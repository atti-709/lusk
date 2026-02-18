import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { uploadRoute } from "../routes/upload.js";
import { tempManager } from "../services/TempManager.js";

describe("POST /api/upload", () => {
  const app = Fastify();
  const createdSessions: string[] = [];

  beforeAll(async () => {
    await tempManager.init();
    await app.register(uploadRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Promise.all(
      createdSessions.map((id) =>
        rm(join(tempManager.baseDir, id), { recursive: true, force: true })
      )
    );
  });

  it("rejects requests without a file", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a video file upload", async () => {
    const boundary = "----testboundary";
    const payload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n` +
      `fake-video-content\r\n` +
      `--${boundary}--\r\n`;

    const response = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBeDefined();
    createdSessions.push(body.sessionId);
    expect(body.fileName).toBe("input.mp4");
    expect(body.url).toMatch(/^\/static\/[^/]+\/input\.mp4$/);

    // Verify session directory and file were created
    const sessionDir = join(tempManager.baseDir, body.sessionId);
    const info = await stat(join(sessionDir, "input.mp4"));
    expect(info.isFile()).toBe(true);
  });
});

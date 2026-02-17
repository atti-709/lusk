import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadRoute, TEMP_DIR } from "../routes/upload.js";

describe("POST /api/upload", () => {
  const app = Fastify();

  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
    await app.register(uploadRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(TEMP_DIR, { recursive: true, force: true });
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
    expect(body.fileName).toBeDefined();
    expect(body.url).toMatch(/^\/uploads\//);

    // Verify file was actually saved
    const files = await readdir(TEMP_DIR);
    expect(files.length).toBeGreaterThan(0);
  });
});

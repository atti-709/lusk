import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { staticPlugin } from "../plugins/static.js";
import { tempManager } from "../services/TempManager.js";

describe("Static file serving", () => {
  const app = Fastify();
  const sessionId = "test-session";

  beforeAll(async () => {
    const sessionDir = join(tempManager.baseDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "input.mp4"), "fake-video-content");
    await app.register(staticPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(join(tempManager.baseDir, sessionId), { recursive: true, force: true });
  });

  it("serves files from session directory at /static/", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/static/${sessionId}/input.mp4`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("fake-video-content");
  });

  it("returns 404 for missing files", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/static/nonexistent/input.mp4",
    });
    expect(response.statusCode).toBe(404);
  });
});

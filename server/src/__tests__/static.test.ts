import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { staticPlugin, TEMP_DIR } from "../plugins/static.js";

describe("Static file serving", () => {
  const app = Fastify();

  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
    await writeFile(join(TEMP_DIR, "test-file.txt"), "hello world");
    await app.register(staticPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it("serves files from temp directory at /uploads/", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/uploads/test-file.txt",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hello world");
  });

  it("returns 404 for missing files", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/uploads/nonexistent.mp4",
    });
    expect(response.statusCode).toBe(404);
  });
});

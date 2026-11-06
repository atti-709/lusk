import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { registerAuth, withToken, cookieName } from "../auth.js";
import { staticPlugin } from "../plugins/static.js";
import { tempManager } from "../services/TempManager.js";

const TOKEN = "t0ken-for-tests";
const PORT = 3999;
const HOST = { host: `127.0.0.1:${PORT}` };
const APP = `http://127.0.0.1:${PORT}`;

describe("per-launch token", () => {
  const app = Fastify();
  const sessionId = "auth-test-session";

  beforeAll(async () => {
    const dir = join(tempManager.baseDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "input.mp4"), "fake-video");
    await registerAuth(app, { token: TOKEN, port: PORT, extraOrigins: ["http://localhost:5173"] });
    app.get("/api/ping", async () => ({ ok: true }));
    app.delete("/api/things", async () => ({ deleted: true }));
    await app.register(staticPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(join(tempManager.baseDir, sessionId), { recursive: true, force: true });
  });

  it("rejects an API call without the token (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: HOST });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: { ...HOST, "x-lusk-token": "nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the header token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/ping", headers: { ...HOST, "x-lusk-token": TOKEN } });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the cookie token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { ...HOST, cookie: `other=1; ${cookieName(PORT)}=${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("ignores a cookie of another instance's port", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { ...HOST, cookie: `${cookieName(PORT + 1)}=${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { host: `evil.example:${PORT}`, "x-lusk-token": TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });

  it("static media: 401 without a token, 200 with cookie or query token", async () => {
    const url = `/static/${sessionId}/input.mp4`;
    expect((await app.inject({ method: "GET", url, headers: HOST })).statusCode).toBe(401);
    const viaCookie = await app.inject({ method: "GET", url, headers: { ...HOST, cookie: `${cookieName(PORT)}=${TOKEN}` } });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.body).toBe("fake-video");
    const viaQuery = await app.inject({ method: "GET", url: withToken(url, TOKEN), headers: HOST });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.body).toBe("fake-video");
  });

  it("serves range requests on media with the query token", async () => {
    const res = await app.inject({
      method: "GET",
      url: withToken(`/static/${sessionId}/input.mp4`, TOKEN),
      headers: { ...HOST, range: "bytes=0-3" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe("fake");
  });

  it("trades a query token for an HttpOnly SameSite=Strict cookie on a page load", async () => {
    const res = await app.inject({ method: "GET", url: `/?lusk_token=${TOKEN}&x=1`, headers: HOST });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/?x=1");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${cookieName(PORT)}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("CORS: allows the app origin and the dev origin", async () => {
    for (const origin of [APP, "http://localhost:5173"]) {
      const res = await app.inject({ method: "GET", url: "/api/ping", headers: { ...HOST, "x-lusk-token": TOKEN, origin } });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("CORS: another origin gets no allow header and its preflight is refused", async () => {
    const get = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { ...HOST, "x-lusk-token": TOKEN, origin: "https://evil.example" },
    });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/api/things",
      headers: {
        ...HOST,
        origin: "https://evil.example",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-lusk-token",
      },
    });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("withToken appends with ? or &", () => {
    expect(withToken("http://x/a.mp4", "k")).toBe("http://x/a.mp4?lusk_token=k");
    expect(withToken("http://x/a.mp4?t=1", "k")).toBe("http://x/a.mp4?t=1&lusk_token=k");
    expect(withToken("http://x/a.mp4", undefined)).toBe("http://x/a.mp4");
  });
});

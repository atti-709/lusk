import { execSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { expect, test } from "@playwright/test";
import { launchLusk } from "./harness";

/** First non-internal IPv4 address (the machine's LAN IP), if it has one. */
function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

test("the server demands the launch token and is not reachable on the LAN", async () => {
  const lusk = await launchLusk({ headless: true });
  try {
    // No token: refused on every kind of route
    for (const p of ["/api/health", "/api/settings", "/api/projects/recent", "/static/x/input.mp4", "/"]) {
      const res = await fetch(`${lusk.baseUrl}${p}`);
      expect(res.status, p).toBe(401);
    }
    // Wrong token
    const wrong = await fetch(`${lusk.baseUrl}/api/health`, { headers: { "x-lusk-token": "nope" } });
    expect(wrong.status).toBe(401);
    // Right token, three ways
    expect((await lusk.fetch("/api/health")).status).toBe(200);
    expect((await fetch(`${lusk.baseUrl}/api/health?lusk_token=${lusk.token}`)).status).toBe(200);
    // A foreign page's origin gets no CORS allowance
    const cors = await lusk.fetch("/api/health", { headers: { Origin: "https://evil.example" } });
    expect(cors.headers.get("access-control-allow-origin")).toBeNull();

    // Not listening beyond loopback
    const ip = lanIp();
    if (ip) {
      const lan = await fetch(`http://${ip}:${lusk.port}/api/health`, {
        headers: { "x-lusk-token": lusk.token },
        signal: AbortSignal.timeout(3000),
      }).then(
        (r) => `reachable ${r.status}`,
        () => "refused",
      );
      expect(lan).toBe("refused");
      const listeners = execSync(`lsof -nP -iTCP:${lusk.port} -sTCP:LISTEN || true`, { encoding: "utf-8" });
      expect(listeners).toContain(`127.0.0.1:${lusk.port}`);
      expect(listeners).not.toMatch(/\*:\d+|\[::\]/);
    }
  } finally {
    await lusk.close();
  }
});

test("the app window gets its cookie: dashboard loads and its API calls work", async () => {
  const lusk = await launchLusk();
  try {
    expect(new URL(lusk.window.url()).search).toBe(""); // token not left in the URL
    await expect(lusk.window.getByRole("button", { name: "Open Project..." })).toBeVisible();
    // A fetch from the page itself (cookie only, no header) is authorised
    const status = await lusk.window.evaluate(() => fetch("/api/health").then((r) => r.status));
    expect(status).toBe(200);
  } finally {
    await lusk.close();
  }
});

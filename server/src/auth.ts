import type { FastifyInstance, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";

/**
 * Per-launch access control for the local server.
 *
 * The server listens on 127.0.0.1 only, but any web page in the user's browser can still
 * send requests to it, so every request must carry the launch token:
 *   - `x-lusk-token` header: API clients (harness, tools, dev proxy, Electron main)
 *   - `lusk_token_<port>` cookie: the app window (fetch, EventSource, <video>, Remotion Player)
 *   - `lusk_token` query parameter: Remotion's headless Chrome and compositor during renders,
 *     which cannot send headers or cookies. On a page navigation it also sets the cookie.
 */
export const TOKEN_HEADER = "x-lusk-token";
export const TOKEN_QUERY = "lusk_token";
export const cookieName = (port: number): string => `lusk_token_${port}`;

export interface AuthOptions {
  token: string;
  port: number;
  /** Extra browser origins allowed to call the API (dev: the Vite server). */
  extraOrigins?: string[];
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function firstString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Register on the root instance before any route: the hooks then cover every route. */
export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const { token, port } = opts;
  const appOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(opts.extraOrigins ?? []),
  ]);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const cookie = cookieName(port);

  const queryToken = (req: FastifyRequest): string | undefined =>
    firstString((req.query as Record<string, unknown> | undefined)?.[TOKEN_QUERY]);
  const hasValidQuery = (req: FastifyRequest): boolean => safeEqual(queryToken(req), token);

  // CORS: only the app's own origins. A request with a valid query token (Remotion's
  // headless Chrome, whose origin is its own bundle server) is let through as well.
  await app.register(cors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, {
        origin: !origin || appOrigins.has(origin) || hasValidQuery(req as FastifyRequest),
        allowedHeaders: ["content-type", TOKEN_HEADER],
        credentials: true,
      });
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return; // preflight, answered by cors (no data)

    // DNS rebinding: a hostile name pointing at 127.0.0.1 would arrive with its own Host
    if (!allowedHosts.has(req.headers.host ?? "")) {
      return reply.code(403).send({ error: "Forbidden host" });
    }

    const viaQuery = hasValidQuery(req);
    const ok =
      safeEqual(firstString(req.headers[TOKEN_HEADER]), token) ||
      safeEqual(cookieValue(req.headers.cookie, cookie), token) ||
      viaQuery;
    if (!ok) return reply.code(401).send({ error: "Unauthorized" });

    // Opening the app: trade the query token for a cookie and drop it from the URL
    const path = req.url.split("?")[0];
    if (
      viaQuery &&
      req.method === "GET" &&
      !path.startsWith("/api/") &&
      !path.startsWith("/static/") &&
      !path.startsWith("/public/") &&
      !path.startsWith("/config-assets/")
    ) {
      const url = new URL(req.url, "http://x");
      url.searchParams.delete(TOKEN_QUERY);
      reply.header("set-cookie", `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return reply.redirect(url.pathname + url.search, 302);
    }
  });
}

/** Append the token to a URL that Remotion's browser or compositor will fetch. */
export function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${TOKEN_QUERY}=${encodeURIComponent(token)}`;
}

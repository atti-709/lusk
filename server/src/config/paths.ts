import path from "node:path";
import fs from "node:fs";

/**
 * Resolve client/public directory for static assets (outro.mp4, etc.).
 * Used by static plugin and RenderService.
 */
export function getClientPublicDir(): string {
  if (process.env.LUSK_PUBLIC_DIR) return process.env.LUSK_PUBLIC_DIR;
  // From server/src/config (this file) -> repo/client/public
  const fromMeta = path.resolve(import.meta.dirname, "../../../client/public");
  if (fs.existsSync(fromMeta)) return fromMeta;
  // Fallback: cwd may be server/ (npm run dev -w server) or repo root
  const fromServer = path.resolve(process.cwd(), "../client/public");
  const fromRoot = path.resolve(process.cwd(), "client/public");
  if (fs.existsSync(fromServer)) return fromServer;
  if (fs.existsSync(fromRoot)) return fromRoot;
  return fromMeta;
}

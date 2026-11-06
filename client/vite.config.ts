import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: the server demands a token on every request (server/src/auth.ts); the proxy adds it
// so the browser tab needs none. Must match LUSK_TOKEN of `npm run dev` for the server.
const devToken = process.env.LUSK_TOKEN ?? "lusk-dev-token";
const proxied = { target: "http://127.0.0.1:3000", changeOrigin: true, headers: { "x-lusk-token": devToken } };

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": proxied,
      "/static": proxied,
    },
  },
});

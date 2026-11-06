import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: the server demands a token on every request (server/src/auth.ts); the proxy adds it
// so the browser tab needs none. The root `npm run dev` makes a random LUSK_TOKEN per start and
// hands it to both; never a fixed one: the server also accepts the token in a URL, so any web
// page that knew it could read projects and spend the Gemini key.
const devToken = process.env.LUSK_TOKEN;
const proxied = { target: "http://127.0.0.1:3000", changeOrigin: true, headers: devToken ? { "x-lusk-token": devToken } : {} };

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": proxied,
      "/static": proxied,
    },
  },
});

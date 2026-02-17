# Phase 1: Local Server Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold a working monorepo with a Fastify backend that accepts video uploads and serves them as static files, and a React frontend with a drag-and-drop upload UI.

**Architecture:** npm workspaces monorepo with `server/` (Fastify + TypeScript, port 3001) and `client/` (React + Vite + TypeScript, port 5173). Client proxies `/api` to server. Shared types in `shared/`.

**Tech Stack:** Fastify, @fastify/multipart, @fastify/static, @fastify/cors, React, Vite, TypeScript, Vitest

---

### Task 1: Initialize Monorepo Root

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.base.json`

**Step 1: Initialize git**

```bash
git init
```

**Step 2: Create root package.json**

Create `package.json`:

```json
{
  "name": "lusk",
  "private": true,
  "workspaces": [
    "server",
    "client",
    "shared"
  ],
  "scripts": {
    "dev": "npm run dev --workspace=server & npm run dev --workspace=client",
    "dev:server": "npm run dev --workspace=server",
    "dev:client": "npm run dev --workspace=client"
  }
}
```

**Step 3: Create .gitignore**

Create `.gitignore`:

```
node_modules/
dist/
temp/
output/
.env
*.log
.DS_Store
```

**Step 4: Create base tsconfig**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 5: Commit**

```bash
git add package.json .gitignore tsconfig.base.json CLAUDE.md ROADMAP.md docs/
git commit -m "chore: initialize monorepo with npm workspaces"
```

---

### Task 2: Create Shared Types Package

**Files:**
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Create: `shared/types.ts`

**Step 1: Create shared/package.json**

```json
{
  "name": "@lusk/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./types.ts",
  "types": "./types.ts"
}
```

**Step 2: Create shared/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["./**/*.ts"]
}
```

**Step 3: Create shared/types.ts**

```typescript
export interface UploadResponse {
  success: boolean;
  fileName: string;
  url: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

export interface ErrorResponse {
  success: false;
  error: string;
}
```

**Step 4: Commit**

```bash
git add shared/
git commit -m "feat: add shared types package"
```

---

### Task 3: Scaffold Server Package

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`

**Step 1: Create server/package.json**

```json
{
  "name": "@lusk/server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fastify": "^5.2.1",
    "@fastify/cors": "^11.0.1",
    "@fastify/multipart": "^9.0.3",
    "@fastify/static": "^8.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.13.4",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.6"
  }
}
```

**Step 2: Create server/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../shared" }
  ]
}
```

**Step 3: Create server entry point**

Create `server/src/index.ts`:

```typescript
import Fastify from "fastify";
import cors from "@fastify/cors";

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });

server.get("/api/health", async () => {
  return { status: "ok" as const, uptime: process.uptime() };
});

const PORT = 3001;

try {
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

export { server };
```

**Step 4: Install dependencies**

```bash
cd /Users/atti/Source/Repos/lusk && npm install
```

**Step 5: Verify server starts**

```bash
cd /Users/atti/Source/Repos/lusk && npx tsx server/src/index.ts &
sleep 2
curl http://localhost:3001/api/health
kill %1
```

Expected: `{"status":"ok","uptime":...}`

**Step 6: Commit**

```bash
git add server/ package-lock.json
git commit -m "feat: scaffold Fastify server with health endpoint"
```

---

### Task 4: Add Upload Route

**Files:**
- Create: `server/src/routes/upload.ts`
- Modify: `server/src/index.ts`
- Create: `server/src/__tests__/upload.test.ts`

**Step 1: Write the failing test**

Create `server/src/__tests__/upload.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/atti/Source/Repos/lusk && npm test --workspace=server
```

Expected: FAIL — module `../routes/upload.js` not found.

**Step 3: Implement the upload route**

Create `server/src/routes/upload.ts`:

```typescript
import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadResponse, ErrorResponse } from "@lusk/shared";

export const TEMP_DIR = join(process.cwd(), "temp");

export async function uploadRoute(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
    },
  });

  app.post<{ Reply: UploadResponse | ErrorResponse }>(
    "/api/upload",
    async (request, reply) => {
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      await mkdir(TEMP_DIR, { recursive: true });

      const ext = extname(data.filename) || ".mp4";
      const savedName = `${randomUUID()}${ext}`;
      const savePath = join(TEMP_DIR, savedName);

      await pipeline(data.file, createWriteStream(savePath));

      return {
        success: true as const,
        fileName: savedName,
        url: `/uploads/${savedName}`,
      };
    }
  );
}
```

**Step 4: Register the upload route in index.ts**

Add to `server/src/index.ts`, after cors registration:

```typescript
import { uploadRoute } from "./routes/upload.js";

// ... after cors registration:
await server.register(uploadRoute);
```

**Step 5: Run test to verify it passes**

```bash
cd /Users/atti/Source/Repos/lusk && npm test --workspace=server
```

Expected: PASS

**Step 6: Commit**

```bash
git add server/src/routes/upload.ts server/src/__tests__/upload.test.ts server/src/index.ts
git commit -m "feat: add file upload endpoint with multipart handling"
```

---

### Task 5: Add Static File Serving

**Files:**
- Create: `server/src/plugins/static.ts`
- Modify: `server/src/index.ts`

**Step 1: Write the test**

Add to `server/src/__tests__/upload.test.ts` (or create a new test file `server/src/__tests__/static.test.ts`):

Create `server/src/__tests__/static.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/atti/Source/Repos/lusk && npm test --workspace=server
```

Expected: FAIL — module not found.

**Step 3: Implement static plugin**

Create `server/src/plugins/static.ts`:

```typescript
import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const TEMP_DIR = join(process.cwd(), "temp");

export async function staticPlugin(app: FastifyInstance) {
  await mkdir(TEMP_DIR, { recursive: true });

  await app.register(fastifyStatic, {
    root: TEMP_DIR,
    prefix: "/uploads/",
  });
}
```

**Step 4: Register in index.ts**

Add to `server/src/index.ts`:

```typescript
import { staticPlugin } from "./plugins/static.js";

// ... after upload route registration:
await server.register(staticPlugin);
```

**Step 5: Run tests**

```bash
cd /Users/atti/Source/Repos/lusk && npm test --workspace=server
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git add server/src/plugins/static.ts server/src/__tests__/static.test.ts server/src/index.ts
git commit -m "feat: serve uploaded files as static assets at /uploads/"
```

---

### Task 6: Scaffold Client Package

**Files:**
- Create: `client/` (via Vite scaffold)
- Modify: `client/vite.config.ts` (add proxy)

**Step 1: Scaffold React + Vite + TypeScript app**

```bash
cd /Users/atti/Source/Repos/lusk && npm create vite@latest client -- --template react-ts
```

**Step 2: Configure Vite proxy**

Replace `client/vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
```

**Step 3: Install client dependencies**

```bash
cd /Users/atti/Source/Repos/lusk && npm install
```

**Step 4: Verify client starts**

```bash
cd /Users/atti/Source/Repos/lusk && npm run dev --workspace=client &
sleep 3
curl -s http://localhost:5173 | head -5
kill %1
```

Expected: HTML response from Vite dev server.

**Step 5: Commit**

```bash
git add client/
git commit -m "feat: scaffold React + Vite client with API proxy"
```

---

### Task 7: Build Upload UI Component

**Files:**
- Create: `client/src/components/UploadZone.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/App.css`

**Step 1: Create UploadZone component**

Create `client/src/components/UploadZone.tsx`:

```tsx
import { useState, useCallback, type DragEvent, type ChangeEvent } from "react";

interface UploadState {
  status: "idle" | "dragging" | "uploading" | "done" | "error";
  fileName?: string;
  videoUrl?: string;
  error?: string;
  progress?: number;
}

export function UploadZone() {
  const [state, setState] = useState<UploadState>({ status: "idle" });

  const handleUpload = useCallback(async (file: File) => {
    setState({ status: "uploading", fileName: file.name });

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const data = await response.json();
      setState({
        status: "done",
        fileName: file.name,
        videoUrl: data.url,
      });
    } catch (err) {
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setState((s) => ({ ...s, status: "idle" }));
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setState((s) => ({ ...s, status: "dragging" }));
  }, []);

  const onDragLeave = useCallback(() => {
    setState((s) => ({ ...s, status: "idle" }));
  }, []);

  const onFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  return (
    <div
      className={`upload-zone ${state.status}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {state.status === "idle" && (
        <>
          <p>Drag & drop a video file here</p>
          <label className="file-label">
            or click to browse
            <input
              type="file"
              accept="video/*"
              onChange={onFileSelect}
              hidden
            />
          </label>
        </>
      )}

      {state.status === "dragging" && <p>Drop your video here</p>}

      {state.status === "uploading" && (
        <p>Uploading {state.fileName}...</p>
      )}

      {state.status === "done" && (
        <div>
          <p>Uploaded: {state.fileName}</p>
          {state.videoUrl && (
            <video src={state.videoUrl} controls width={400} />
          )}
        </div>
      )}

      {state.status === "error" && (
        <div>
          <p className="error">{state.error}</p>
          <button onClick={() => setState({ status: "idle" })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Update App.tsx**

Replace `client/src/App.tsx`:

```tsx
import { UploadZone } from "./components/UploadZone";
import "./App.css";

function App() {
  return (
    <div className="app">
      <h1>Lusk</h1>
      <p className="subtitle">Create viral shorts from Slovak video podcasts</p>
      <UploadZone />
    </div>
  );
}

export default App;
```

**Step 3: Update App.css**

Replace `client/src/App.css`:

```css
.app {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
  font-family: system-ui, -apple-system, sans-serif;
}

h1 {
  font-size: 2.5rem;
  margin-bottom: 0.25rem;
}

.subtitle {
  color: #888;
  margin-bottom: 2rem;
}

.upload-zone {
  border: 2px dashed #555;
  border-radius: 12px;
  padding: 3rem 2rem;
  transition: all 0.2s;
  cursor: pointer;
}

.upload-zone.dragging {
  border-color: #646cff;
  background: rgba(100, 108, 255, 0.05);
}

.upload-zone p {
  margin: 0.5rem 0;
}

.file-label {
  color: #646cff;
  cursor: pointer;
  text-decoration: underline;
}

.error {
  color: #ff4444;
}

video {
  margin-top: 1rem;
  border-radius: 8px;
}
```

**Step 4: Verify manually**

Start both server and client, drag a video file, confirm it uploads and the video plays back.

```bash
cd /Users/atti/Source/Repos/lusk && npm run dev
```

**Step 5: Commit**

```bash
git add client/src/components/UploadZone.tsx client/src/App.tsx client/src/App.css
git commit -m "feat: add drag-and-drop video upload UI"
```

---

### Task 8: End-to-End Smoke Test

**Goal:** Verify the full flow works: upload a file via the client, confirm it's served back.

**Step 1: Start both services**

```bash
cd /Users/atti/Source/Repos/lusk && npm run dev
```

**Step 2: Test upload via curl**

In another terminal:

```bash
echo "test-content" > /tmp/test-video.mp4
curl -F "file=@/tmp/test-video.mp4" http://localhost:3001/api/upload
```

Expected: `{"success":true,"fileName":"<uuid>.mp4","url":"/uploads/<uuid>.mp4"}`

**Step 3: Test static serving**

```bash
curl http://localhost:3001/uploads/<uuid-from-above>.mp4
```

Expected: `test-content`

**Step 4: Test health endpoint**

```bash
curl http://localhost:3001/api/health
```

Expected: `{"status":"ok","uptime":...}`

**Step 5: Clean up and commit any fixes**

```bash
git add -A && git commit -m "chore: phase 1 complete — server foundation with upload and static serving"
```

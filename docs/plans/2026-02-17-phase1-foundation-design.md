# Phase 1: Local Server Foundation — Design

## Overview

Scaffold a monorepo with a Fastify backend and React (Vite) frontend. Establish the API layer and static file serving needed for video upload and playback.

## Architecture

**Monorepo:** npm workspaces with two packages at root level (`server/`, `client/`) plus a `shared/` directory for common TypeScript types.

**Server (port 3001):** Fastify + TypeScript. Handles multipart file uploads, saves to `./temp/`, serves uploaded files as static assets.

**Client (port 5173):** React + Vite + TypeScript. Proxies `/api` requests to the server. Provides a drag-and-drop upload UI.

## Directory Structure

```
lusk/
├── package.json          # Root workspace config
├── tsconfig.base.json    # Shared TS config
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts      # Fastify setup + start
│       ├── routes/
│       │   └── upload.ts # POST /api/upload
│       └── plugins/
│           └── static.ts # Serve ./temp/ at /uploads/
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       └── components/
│           └── UploadZone.tsx
├── shared/
│   └── types.ts          # Shared API types
├── CLAUDE.md
└── ROADMAP.md
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/upload | Accept video file (multipart), save to ./temp/ |
| GET | /api/health | Server health check |
| Static | /uploads/* | Serve files from ./temp/ |

## Tech Choices

- **@fastify/multipart** for upload handling
- **@fastify/static** for serving temp files
- **@fastify/cors** for cross-origin requests during development
- **Vite proxy** to forward /api calls from client dev server to Fastify

## Decisions

- Server on port 3001, client on Vite default 5173
- Flat workspace layout (server/ and client/ at root, not under packages/)
- Shared types in shared/ directory, referenced via TypeScript path aliases

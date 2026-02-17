# **Lusk: Project Roadmap (Local Node.js Architecture)**

## **Phase 1: The Local Server Foundation**

**Objective:** Set up a Monorepo with a Node.js Backend and React Frontend.

* \[ \] **Scaffold:**
  * Create a monorepo (using Turborepo or simple npm workspaces).
  * /server: Node.js (Express or Fastify) + TypeScript.
  * /client: React + Vite + TypeScript.
* \[ \] **API Layer (The Bridge):**
  * Set up tRPC or simple REST endpoints to connect Client and Server.
  * Define routes: POST /upload, POST /transcribe, GET /status, POST /render.
* \[ \] **File System & Session Management:**
  * Implement a TempManager class in /server.
  * **Logic:** Create a unique .lusk_temp/{sessionId} folder for each run.
  * **Cleanup:** On server startup, delete any .lusk_temp folders older than 24 hours (or just wipe previous runs).
  * **Serving:** Configure Express/Fastify to serve .lusk_temp statically so the UI can play the videos.

## **Phase 1.5: Orchestration & Visualization**

**Objective:** Manage the AI pipeline state on the server.

* \[ \] **Backend Orchestrator:**
  * Implement a State Machine in /server/orchestrator.ts.
  * States: IDLE -> PROCESSING_UPLOAD -> TRANSCRIBING -> ALIGNING -> ANALYZING -> READY.
  * **WebSockets/Polling:** Implement a mechanism for the frontend to receive real-time updates (e.g., "Transcription: 45%").
* \[ \] **Frontend Visualization:**
  * Build a PipelineStepper component.
  * Connect it to the live status endpoint to show progress.

## **Phase 2: Whisper.cpp Integration (Server Side)**

**Objective:** Run Metal-accelerated transcription on the backend.

* \[ \] **Integration:**
  * Install @remotion/install-whisper-cpp in the /server package.
  * Implement a model downloader (fetch ggml-large-v3.bin to a local ./models folder).
* \[ \] **Execution:**
  * Endpoint: POST /transcribe.
  * Action: Spawn whisper-cpp against the uploaded file.
  * **Optimization:** Ensure COREML=1 or Metal support is active for Apple Silicon speed.
* \[ \] **Response:**
  * Parse the JSON output and store it in a server-side "Project State".

## **Phase 3: Alignment & Intelligence (Server Side)**

**Objective:** Run Llama 3 and Alignment algorithms.

* \[ \] **Viral Finder (Node Llama):**
  * Install node-llama-cpp in /server.
  * **Task:** Run Llama 3 inference on the transcript to find viral hooks.
  * **Output:** Return a list of TimelineSegments (start/end times).
* \[ \] **Text Correction (TypeScript):**
  * Implement **Needleman-Wunsch** algorithm in /server/utils/alignment.ts.
  * Align the Whisper JSON with the user-provided Source_Text.md.

## **Phase 4: The Studio (Client Side)**

**Objective:** The Visual Editor in the Browser.

* \[ \] **Player UI:**
  * Integrate Remotion Player (9:16 Composition).
  * **Source:** Point the video src to http://localhost:3000/static/{sessionId}/input.mp4.
* \[ \] **Captioning:**
  * Use @remotion/captions inside the Composition.
  * Fetch the *aligned* transcript from the server to drive the captions.
  * **Style:** TikTok-style pop effects + Montserrat font (Latin Extended).

## **Phase 5: Export Pipeline**

**Objective:** Server-side rendering and download.

* \[ \] **Rendering:**
  * Endpoint: POST /render.
  * Action: Server calls @remotion/renderer -> renderMedia().
  * **Hardware Accel:** Pass -c:v h264_videotoolbox to FFmpeg.
* \[ \] **Download:**
  * Once rendering finishes, the server returns a URL to the generated MP4.
  * Frontend triggers a browser download.
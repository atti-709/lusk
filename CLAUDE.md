# **Project Context: Lusk (Local Node.js Server)**

## **Project Overview**

**Lusk** is a Local-First Web Application to create viral vertical shorts from Slovak video podcasts.

**Architecture:** Standard **Client-Server Architecture** running entirely on localhost.

* **Frontend:** React (Vite) running in the user's browser.  
* **Backend:** Node.js server running on the user's machine (doing the heavy AI/Video work).  
* **Target Hardware:** Apple Silicon (M1/M2/M3) using Metal acceleration.

## **File Structure & Lifecycle**

* **Root:** Lusk/
* **Temp Storage:** Lusk/server/.lusk_temp/{sessionId}/
  * This folder holds the uploaded input.mp4, the transcript.json, and the rendered output.mp4.
* **Session Persistence:**
  * On startup the server **restores** existing sessions from disk so in-progress work survives restarts.
  * Files persist during the session to allow for page reloads or crashes without data loss.
  * Old sessions can be deleted via `DELETE /api/sessions/{sessionId}`.

## **Tech Stack**

* **Server:** Node.js + Fastify + TypeScript.
* **Client:** React + Vite + TypeScript.
* **AI:** @remotion/install-whisper-cpp, node-llama-cpp.
* **Video:** Remotion (Player & Renderer).

## **Feature Implementation Details**

### **1. File Handling (Uploads)**

* **Flow:** User drags video to Browser -> Browser uploads to http://localhost:3000/api/upload -> Server saves to .lusk_temp/{sessionId}/input.mp4.
* **Access:** Server statically serves .lusk_temp so the frontend Player can access the video via URL (e.g., /static/{sessionId}/input.mp4).

### **2. Transcription (Server Side)**

* **Library:** @remotion/install-whisper-cpp (for install/download only). Transcription runs via whisper-cli directly.
* **Flags:** `-ojf` (full JSON with per-token timestamps), `-l sk` (Slovak).
* **Word Timing:** Segment-level timestamps are used as anchors (they accurately capture inter-sentence silence). Within a segment, BPE token offsets provide per-word timing. Segment `text` is used for word strings (correct UTF-8); token `text` is ignored (may corrupt multi-byte Slovak chars like ľ, ď, ň).
* **Timing Offset:** A small forward offset (`TIMING_OFFSET_MS` in WhisperService.ts) is applied to all word timestamps to compensate for Whisper's early-firing cross-attention alignment.

### **3. Viral Clip Detection (Server Side)**

* **Library:** node-llama-cpp.
* **Model:** Llama-3-8B-Instruct.Q4_K_M.gguf.
* **Process:** Server runs inference on the transcript logic to find "Viral Hooks" and returns JSON to the client.

### **4. Text Correction (Server Side)**

* **Algorithm:** **Needleman-Wunsch** (Global Alignment).
* **Location:** /server/src/services/AlignmentService.ts.
* **Task:** Run alignment on the server immediately after transcription if a script is provided.
* **Fuzzy Logic:** Normalize text (strip diacritics) before aligning to handle "Script vs Spoken" differences.

### **5. Caption Rendering (Client Side)**

* **Library:** @remotion/captions.
* **Data Flow:** Client fetches GET /api/project/transcript (which contains the aligned, corrected data).
* **Component:** Passes this data to createTikTokStyleCaptions.

### **6. Export (Server Side)**

* **Engine:** @remotion/renderer via `RenderService` (`/server/src/services/RenderService.ts`).
* **Bundling:** `@remotion/bundler` bundles `client/src/remotion/index.ts` once (cached in memory after first render).
* **Rendering:** `renderMedia()` with `selectComposition()` to set per-clip duration and inputProps.
* **Hardware Acceleration:** `hardwareAcceleration: 'if-possible'`, `videoBitrate: '6000k'`, codec `h264`. On Apple Silicon this uses VideoToolbox automatically.
* **Delivery:** Server renders to `.lusk_temp/{sessionId}/output.mp4` and sets the download URL via orchestrator.

## **User Instructions**

* When asking for code, specify if it belongs in the **/server** or **/client** directory.
* Ensure API types are shared between client and server (if using TypeScript).
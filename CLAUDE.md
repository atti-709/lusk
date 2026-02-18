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

* **Status:** Currently a **mock implementation** (`runMockRender` in /server/src/routes/render.ts) with simulated delays. Does not produce a real video file yet.
* **Planned Engine:** @remotion/renderer.
* **Planned Hardware Acceleration:**
  codec: "h264",
  encoderOptions: {
    ffmpegOptions: ["-c:v", "h264_videotoolbox", "-b:v", "6000k"]
  }

* **Delivery:** Server will render the file to .lusk_temp/{sessionId}/output.mp4 and return the download URL.

## **User Instructions**

* When asking for code, specify if it belongs in the **/server** or **/client** directory.
* Ensure API types are shared between client and server (if using TypeScript).
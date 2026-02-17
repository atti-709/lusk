# **Project Context: Lusk (Local Node.js Server)**

## **Project Overview**

**Lusk** is a Local-First Web Application to create viral vertical shorts from Slovak video podcasts.

**Architecture:** Standard **Client-Server Architecture** running entirely on localhost.

* **Frontend:** React (Vite) running in the user's browser.  
* **Backend:** Node.js server running on the user's machine (doing the heavy AI/Video work).  
* **Target Hardware:** Apple Silicon (M1/M2/M3) using Metal acceleration.

## **Architecture Details**

* **Server (Node.js):**  
  * Hosts the API and serves static assets (video files).  
  * Runs the "Heavy Iron": whisper.cpp (ASR), node-llama-cpp (AI), and ffmpeg (Rendering).  
  * Manages the Project State (current transcript, viral clips).  
* **Client (React):**  
  * Provides the UI: Video Player, Editor, Progress bars.  
  * Communicates with Server via HTTP/REST/WebSockets.

## **Tech Stack**

* **Server:** Node.js \+ Express/Fastify \+ TypeScript.  
* **Client:** React \+ Vite \+ TypeScript.  
* **AI:** @remotion/install-whisper-cpp, node-llama-cpp.  
* **Video:** Remotion (Player & Renderer).

## **Feature Implementation Details**

### **1\. File Handling (Uploads)**

* **Flow:** User drags video to Browser \-\> Browser uploads to http://localhost:3000/api/upload \-\> Server saves to ./temp/.  
* **Access:** Server statically serves ./temp/ so the frontend Player can access the video via URL.

### **2\. Transcription (Server Side)**

* **Library:** @remotion/install-whisper-cpp.  
* **Logic:**  
  1. Server receives request to transcribe ./temp/video.mp4.  
  2. Server spawns whisper-cpp process (using Metal acceleration).  
  3. Server parses output JSON and saves it to state.

### **3\. Viral Clip Detection (Server Side)**

* **Library:** node-llama-cpp.  
* **Model:** Llama-3-8B-Instruct.Q4\_K\_M.gguf.  
* **Process:** Server runs inference on the transcript logic to find "Viral Hooks" and returns JSON to the client.

### **4\. Text Correction (Server Side)**

* **Algorithm:** **Needleman-Wunsch** (Global Alignment).  
* **Location:** /server/utils/alignment.ts.  
* **Task:** Run alignment on the server immediately after transcription if a script is provided.  
* **Fuzzy Logic:** Normalize text (strip diacritics) before aligning to handle "Script vs Spoken" differences.

### **5\. Caption Rendering (Client Side)**

* **Library:** @remotion/captions.  
* **Data Flow:** Client fetches GET /api/project/transcript (which contains the aligned, corrected data).  
* **Component:** Passes this data to createTikTokStyleCaptions.

### **6\. Export (Server Side)**

* **Engine:** @remotion/renderer.  
* **Hardware Acceleration:**  
  codec: "h264",  
  encoderOptions: {  
    ffmpegOptions: \["-c:v", "h264\_videotoolbox", "-b:v", "6000k"\]  
  }

* **Delivery:** Server renders the file to ./output/short.mp4 and returns the download URL.

## **User Instructions**

* When asking for code, specify if it belongs in the **/server** or **/client** directory.  
* Ensure API types are shared between client and server (if using TypeScript).
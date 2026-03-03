# Lusk

Viral vertical shorts from Slovak video podcasts.

## Install

1. Download the latest `.dmg` from [Releases](https://github.com/atti-709/lusk/releases)
2. Open the `.dmg` and drag **Lusk.app** to your Applications folder
3. **Important — macOS Gatekeeper:** Since the app is not code-signed, macOS will block it on first launch. To fix this, open Terminal and run:

   ```bash
   xattr -cr /Applications/Lusk.app
   ```

   Then open Lusk normally. This is a one-time step after each update.

## Prerequisites

Lusk requires these to be installed on your machine:

| Dependency | Purpose | Install |
|---|---|---|
| Python 3 + WhisperX | Transcription + word alignment | `pip3 install whisperx` |

Node.js and ffmpeg are bundled with the app.

## Development

```bash
brew install node ffmpeg
pip3 install whisperx
npm install
npm run dev          # starts server (port 3000) + client (port 5173)
```

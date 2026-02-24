# Project Export/Import Design

## Summary

Allow exporting a Lusk session as a `.lusk` file (zip archive) containing session JSON + optionally the source video, and importing `.lusk` files to restore projects.

## Export

### Contents of `.lusk` archive

- `session.json` — full `ProjectState` snapshot
- `session-meta.json` — lightweight summary
- Optionally: `input.mp4` — original source video (user chooses at export time)

No rendered clips are included.

### Server endpoint

`GET /api/project/:sessionId/export?includeVideo=true|false`

Streams a zip response. Content-Disposition header sets filename to `{videoName}.lusk`.

### Client flow

1. User clicks "Export Project" button in studio view
2. Checkbox option: "Include source video"
3. Client first tries File System Access API (`showSaveFilePicker`) to let user choose save location (ideally next to original video)
4. Falls back to standard browser download if API unavailable or user cancels picker
5. File named `{videoName}.lusk`

## Import

### Server endpoint

`POST /api/import` — accepts multipart upload of a `.lusk` file.

### Server flow

1. Receive and unzip the `.lusk` file
2. Read `session.json` to get the `ProjectState`
3. Create new session directory in `.lusk_temp/{newSessionId}/`
4. Copy `input.mp4` into session dir if present in archive
5. Restore session into orchestrator (new session ID to avoid collisions)
6. If no video in archive, session needs re-upload handling
7. Return new session ID to client

### Client flow

1. User clicks "Import Project" button on sessions screen, or drops `.lusk` file onto upload area
2. Upload `.lusk` file to `POST /api/import`
3. On success, navigate to the restored session

## UI Locations

- **Export:** Button in studio view, near existing render controls. Includes "Include source video" checkbox.
- **Import:** "Import Project" button on home/sessions screen. Also recognizes `.lusk` files dropped onto the existing upload area.

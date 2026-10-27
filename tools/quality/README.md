# Quality tools

## Corpus (`~/LuskCorpus`)

The sermon/panel corpus used to measure transcription, clip and framing quality. The manifest is the Notion
"Corpus" database; `corpus.json` is its checked-in export (ids, titles, channel, language, set, type, minutes, video flag),
so the tools do not need Notion at run time. Keep it in sync by hand. Items with `set: excluded` are skipped.

The folder is outside the repo and must stay out of git and out of synced folders (it holds ~9 GB of media).
Everything in it is untrusted downloaded data: read it with ffprobe/ffmpeg and `JSON.parse`, never execute it.

```
~/LuskCorpus/
  manifest.json            every item: paths, language, set, durations, bytes, captions stats
  <YouTube ID>/
    audio.m4a              yt-dlp bestaudio[ext=m4a]
    audio.wav              16 kHz mono pcm_s16le (length checked against the m4a within 2 s)
    video.mp4              only where Video = 1080p: H.264, <= 1080p (the camera path)
    youtube_auto.json3     raw YouTube auto-captions (sk-orig / cs-orig)
    youtube_auto.srt       clean word-timed SRT rebuilt from json3 (see captions.ts)
    meta.json              yt-dlp metadata subset + the formats chosen
```

### Fetch / re-run

```bash
npx tsx tools/quality/fetch.ts                    # everything; resumable
npx tsx tools/quality/fetch.ts --only 0QqML3YiWTA # one or more ids (comma separated)
npx tsx tools/quality/fetch.ts --audio-only
```

* Audio, captions and meta for every item first, video last. Free space is re-checked before every file; the run stops
  (exit 2) when less than 10 GB would remain. Files that already exist with the right duration are skipped, so just run it again.
* `manifest.json` is rewritten at the end of every run (also when stopped or with errors).
* The auto-captions are rebuilt from json3 `events[].segs[]` (tStartMs + tOffsetMs, skipping events without segs or
  with aAppend), de-duplicated and grouped into cues of up to 2 lines / 42 characters. Check a new item by eye against the
  YouTube player before using it as a baseline. Tests: `npx vitest run tools`.
* **yt-dlp must be recent.** YouTube changes often; the 2026.07.04 Homebrew build got HTTP 403 on every media download
  (the 2026.10.26 PyPI build works, with `deno` for the JS challenge). Point `YT_DLP=/path/to/yt-dlp` at a current one, e.g.
  `python3 -m venv ~/.venvs/yt && ~/.venvs/yt/bin/pip install -U "yt-dlp[default]"`.

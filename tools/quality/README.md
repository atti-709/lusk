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

## Blind A/B listening test (`abtest.py`)

Builds the blind page for two caption versions of any corpus items (sk or cs) and tallies the owner's votes. Python 3
standard library and ffmpeg only; run it with `python3 -I`.

```bash
python3 -I tools/quality/abtest.py build 01-v0 02-twomodel 0QqML3YiWTA Ccj-zhD0YPA \
    [--windows 20] [--seconds 25] [--contested judge_worse.json] [--out ~/LuskCorpus/abtest] [--seed N]
python3 -I tools/quality/abtest.py unblind ~/LuskCorpus/abtest votes.json
python3 -I tools/quality/abtest_test.py        # checks (span finder, window picking, Wilson interval, a build)
```

* **Inputs:** `~/LuskCorpus/manifest.json` (`--manifest`) for each item's language and `audio.wav`, and
  `~/LuskCorpus/runs/<version>/<item>/captions_<lang>.srt` (`--runs`) for both versions. Nothing else is assumed:
  no owner paths, no fixed language.
* **Windows:** spans where the two versions' words differ (punctuation, case and accents ignored, differences up to 3
  words apart merged, as `listen.py` does; diacritics are kept, deliberately unlike `listen.py` which folds them: byt/byť and nas/nás are different words in sk/cs and the owner judges by reading; NFC-normalised so composed vs decomposed forms match) are the candidates, so every window holds a difference. With `--contested`,
  half of the windows are centred on spans the T3 judge marked "worse" or "both wrong" (the rest are random, and all
  random when no file or too few spans); otherwise all are random. Windows of one item never overlap, items are served
  round-robin, the sampling is seeded. `--contested` takes `{"<item>": [{t0, t1, verdict}]}` or a flat list with an
  `item` key per entry; entries whose `verdict` is not worse / old / neither / both wrong are ignored.
* **Output:** `<out>/abtest.html` (self-contained: audio embedded as base64 32 kbps mono MP3, system fonts, no
  external requests; about 130 KB per window) and `<out>/key.json` (window id -> which version is A and B, item, t0,
  t1, `contested` or `random`). Sides are shuffled per window. The page and the window ids carry no version name:
  **the key stays local, never publish it.** Keep the page under the 16 MB artifact limit (20 windows is ~3 MB).
* **Page:** the two captions as A and B, highlighted differences, vote buttons A / B / same (keys 1 2 3) and a note.
  UI text follows each window's language (sk, cs). Votes go to the artifact database as `votes/<window id>` =
  `{choice: "A"|"B"|"same", note}` when the page runs in claude.ai (`window.claude.use("db")`); the "copy votes as
  JSON" button is the fallback (`{id: {choice, note}}`).
* **Publishing:** done by a Claude session with its Artifact tool; the publisher must declare the `db` capability, and `key.json` never leaves the machine; read the votes back
  from the `votes` collection with ArtifactData, save them as JSON and unblind.
* **Unblind:** `unblind` maps votes through the key and prints, per version, the wins and the share of decided votes
  with a 95 % Wilson interval, the split between contested and random windows, and the per-window verdicts with notes.
  Treat the test as a veto, not a win: with 20 votes a 14:6 split is only p ~ 0.06, ties are common, so "the
  candidate's interval includes 50 %" means no veto, not proof of improvement. The main gate is the judge being
  net-positive on every dev item.
* **Output folder and ids:** `--out` defaults to `~/LuskCorpus/abtest` (outside the repo). Window ids end in a per-build
  suffix, so votes left in the artifact database by an older build are ignored by the page and skipped (with a warning) by
  `unblind`. `unblind` accepts `{id: {choice, note}}`, a `{"votes": …}` wrapper, `votes/<id>` keys and lists of
  `{id, choice, note}` or `{id, data}`; a vote without a valid choice is an error.

## Run harness (`run.ts`)

Runs the real app pipeline on corpus items and stores a versioned result. Needs `npm run build:electron` once, the Python
env of the real profile, and a Gemini key in the owner's `config.json` (or `GEMINI_API_KEY`).

```bash
npx tsx tools/quality/run.ts 01-v0 sk4y82zUf9Y Ccj-zhD0YPA          # from the repo root
npx tsx tools/quality/run.ts 01-v0 0QqML3YiWTA --video              # from the item's video.mp4 (framing)
npx tsx tools/quality/run.ts 01-v0 E08 E64 --manifest ~/LuskBatch/corpus_svatonazor.json
LUSK_WHISPER_MODEL=<mlx folder or HF repo> npx tsx tools/quality/run.ts 02-cs-large-v3 <item>   # model variants
```

* `<version>` must match `^\d{2}-[a-z0-9-]+$` (`01-v0`, `02-cs-large-v3`, `00-smoke`); never a bare `v1` that two workstreams reuse.
* One item at a time, each in a fresh headless app (`LUSK_HEADLESS`, no window). The profile is `runs/<version>/.profile`, and its
  `config.json` is rewritten for every item with only: the Gemini key, `translateToEnglish: false` and `transcriptionLanguage` = the
  item's language. Prompt overrides in the owner's real config never leak in. The project is created with the item's language.
* Input is a black proxy `.mov` carrying the item's `audio.wav` (`--video`: the real `video.mp4`). With a `script` its text is
  POSTed before transcription, so the correction pass runs as in production.
* The SRT is fetched right after READY. Output, per item, in `~/LuskCorpus/runs/<version>/<item>/`: `transcript.json` (final words),
  `transcript_raw.json` (heard words before the text passes), `captions_<lang>.srt`, `clips.json`, `log.txt` (this tool's lines, then
  the app/server output) and `meta.json`.
* `meta.json`: `completed`, git `commit` (+ `dirty` for uncommitted source changes), item id/language/set, `settings`, `models`
  (Whisper model for the language, the `LUSK_WHISPER_MODEL` override, the two Gemini models), `timingsSeconds` (transcribe = until
  the transcript is done, gemini = correction/proofread/clips, total; polled each second), `peakRssPythonMb` (sum of the
  `transcribe.py` processes, sampled from `ps` every 2 s), `counts`, and **`passes`**: script correction ran/skipped, proofread
  `{status, applied, rejected}`, clips `{status, count}`, translation `ran|skipped|failed`, `failed`. Proofread, clips and translation
  are non-fatal in the app, so a project reaches READY with a pass silently failed; the server's runtime-only `runReport` (on
  `GET /api/projects/:id`) records it and `passesOk` is false then. **Compare only runs whose `passes` match and `passesOk` is true.**
* Resumable: an item whose `meta.json` has `completed: true` is skipped; a failed one is run again from scratch.
* `~/LuskCorpus/.lock` (pid + start time) is held for the whole run; a second run, or `electron/scripts/batch-episodes.ts`
  (both through `lock.ts`), refuses to start while it is held. A lock whose pid is gone is taken over. Still check
  `pgrep -fl "transcribe.py|track_speaker|remotion"` before a run: other tools do not take the lock.

### Second manifest (Svätonázor regression set)

`--manifest <path>` replaces `corpus.json`. Items are looked up by `id`; relative paths resolve against the manifest's folder and `~/`
is expanded. `wav` / `video` default to `<corpus dir>/<id>/audio.wav` / `video.mp4`.

```json
{ "items": [
  { "id": "E64", "language": "sk", "set": "regression",
    "wav": "~/LuskBatch/audio/E64.wav",
    "script": "<the episode's .md script, optional>" } ] }
```

The owner's copy is `~/LuskBatch/corpus_svatonazor.json` (E00, E08, E35, E64, E65, E71; the script is the episode's Drive-folder
`.md`, else `regen4/script_map.json` + `texts/`, as in `regen4.ts`; E00 has none). It holds owner paths and is not committed.

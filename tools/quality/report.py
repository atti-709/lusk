#!/usr/bin/env python3
"""report.py: quality report for one run version of the corpus (sk or cs), optionally against another version or YouTube.

  python3 -I tools/quality/report.py <version> [--vs <version|youtube>] [--items a b ...] [--manifest <path>]
                                      [--runs <dir>] [--out <dir>] [--skip judge,audit,vad,timing,layout]
                                      [--ref] [--max-spans N] [--batch N]

Writes <out>/<version>[-vs-<other>].md, the same name with .json (every judge and audit decision, the dropped-speech holes,
the timing and layout numbers), .contested.json (the spans the judge marked worse / both wrong, the shape
`abtest.py build --contested` reads) and .checkpoint.json (finished Gemini batches: a rerun resumes from it).

Sections: pass-set guard, A/B listening judge (needs --vs), absolute audit (30 fixed 8 s windows per item), dropped speech,
word timing, layout, speed and memory. Python 3 standard library and ffmpeg; the VAD and the word-timestamp reference pass run in
the app's managed Python (a subprocess) while the shared ~/LuskCorpus/.lock is held. Exit codes: 0 ok, 2 usage / nothing to do,
3 the Gemini API kept failing (nothing is written, the checkpoint keeps what was judged).
"""
import argparse
import base64
import datetime
import difflib
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import time
import unicodedata  # noqa: F401
import urllib.error
import urllib.request
import wave

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import abtest  # noqa: E402  (norm, SRT parsing, the span merge rule and the mp3 cutter are shared with the blind test)

REPO = os.path.dirname(os.path.dirname(HERE))
CORPUS = os.path.expanduser("~/LuskCorpus")
CONFIG = os.path.expanduser("~/Library/Application Support/@lusk/electron/config.json")
MANAGED_PYTHON = os.path.expanduser("~/Library/Application Support/@lusk/electron/python-env/venv/bin/python")
SCRIPTS = os.path.join(REPO, "server", "scripts")
MODEL = "gemini-3.8-flash"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
LANGUAGES = {"sk": "Slovak", "cs": "Czech"}
BATCH = 15                # items per Gemini call
MAX_SNIPPET_S = 25.0      # audio per item
AUDIT_WINDOWS = 30
AUDIT_SECONDS = 8.0
BACKOFF_TOTAL_S = 300     # give up on 429/503 after this long
JUDGE_PROMPT_VERSION = 2
AUDIT_PROMPT_VERSION = 2
ERROR_TYPES = ["mishearing", "dropped word", "inserted word", "ending", "name", "number", "punctuation", "other"]
LOST_MIN_S = 1.0          # a speech hole this long counts
HOLE_MARGIN_S = 0.3       # word times are this loose
TIMING_TH = 0.7           # a cue-start lag beyond this is flagged (timing.py)
MAX_CUE_S = 7.05
MAX_LINE = 42

# ------------------------------------------------------------------------------------------------------ small helpers


class ApiFailure(Exception):
    """The Gemini API kept failing (or answered garbage) after the retries."""


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fmt_t(t):
    t = max(0.0, float(t))
    return f"{int(t // 3600)}:{int(t // 60) % 60:02}:{t % 60:04.1f}" if t >= 3600 else f"{int(t // 60)}:{t % 60:04.1f}"


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def pct(n, d):
    return f"{100 * n / d:.1f}%" if d else "n/a"


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------------------ captions

TAG = re.compile(r"\[[^\]]*\]")
MUSIC_TAG = re.compile(r"hudb|music|zp[eě]v|spev|singing|zp[ií]v[aá]|spieva|chval|♪|♫", re.I)


def strip_tags(text):
    """YouTube sound tags ([hudba], [potlesk], [jásání]) and the >> speaker markers are not words."""
    return re.sub(r"\s+", " ", re.sub(r">{2,}", " ", TAG.sub(" ", text))).strip()


def youtube_cues(path):
    """(cues with the tags stripped, masks). A cue that is only sound tags is dropped from the cues and becomes a mask:
    kind 'music' for [hudba] / singing, 'sound' for the others ([potlesk], [smích]...)."""
    cues, masks = [], []
    for s, e, text in abtest.read_srt(path):
        clean = strip_tags(text)
        tags = " ".join(TAG.findall(text))
        if clean:
            cues.append((s, e, clean))
        elif tags:
            masks.append({"t0": s, "t1": e, "kind": "music" if MUSIC_TAG.search(tags) else "sound", "tag": tags})
    return cues, masks


# Hesitation sounds YouTube transcribes ("eh", "e") and Whisper does not: leaving them out is not an error, so they are no
# difference between two versions and no dropped word.
FILLERS = {"e", "ee", "eee", "eh", "ehh", "ehm", "ehe", "hm", "hmm", "mm", "mhm", "uh", "um", "aha"}


def cue_words(cues):
    """(word, cue start, cue end) for the words of the cues, filler sounds left out."""
    return [w for w in abtest.cue_words(cues) if abtest.norm(w[0]) not in FILLERS]


def spans(old_words, new_words, merge_gap=abtest.MERGE_GAP, context=abtest.CONTEXT):
    """Spans where the word lists differ (abtest's norm: NFC, lower case, no punctuation, diacritics kept; differences up to
    `merge_gap` words apart merge). Each: t0/t1 (the time both sides cover), dt (where the first differing word is), old / new
    (context words), old_diff / new_diff (the differing words)."""
    ko, kn = [abtest.norm(w[0]) for w in old_words], [abtest.norm(w[0]) for w in new_words]
    ops = [o for o in difflib.SequenceMatcher(None, ko, kn, autojunk=False).get_opcodes() if o[0] != "equal"]
    merged = []
    for o in ops:
        if merged and o[1] - merged[-1][2] <= merge_gap and o[3] - merged[-1][4] <= merge_gap:
            merged[-1] = ("replace", merged[-1][1], o[2], merged[-1][3], o[4])
        else:
            merged.append(o)
    out = []
    for _, i1, i2, j1, j2 in merged:
        ci1, ci2 = max(0, i1 - context), min(len(old_words), i2 + context)
        cj1, cj2 = max(0, j1 - context), min(len(new_words), j2 + context)
        ts = [t for w in old_words[ci1:ci2] for t in (w[1], w[2])] + [t for w in new_words[cj1:cj2] for t in (w[1], w[2])]
        if not ts:
            continue
        diff_times = [w[1] for w in new_words[j1:j2]] + [w[1] for w in old_words[i1:i2]]
        out.append({"t0": round(max(0.0, min(ts) - 0.5), 2), "t1": round(max(ts) + 0.7, 2),
                    "dt": round(min(diff_times) if diff_times else min(ts), 2),
                    "old": " ".join(w[0] for w in old_words[ci1:ci2]), "new": " ".join(w[0] for w in new_words[cj1:cj2]),
                    "old_diff": " ".join(w[0] for w in old_words[i1:i2]), "new_diff": " ".join(w[0] for w in new_words[j1:j2])})
    return out


def snippet_range(sp):
    """Audio range for a span: its own range, or 4 s before / 10 s after the first differing word when it is longer than
    20 s (as listen.py does); never over MAX_SNIPPET_S."""
    t0, t1 = sp["t0"], sp["t1"]
    if t1 - t0 > 20:
        t0, t1 = sp["dt"] - 4, sp["dt"] + 10
    t0 = max(0.0, t0)
    return t0, min(t1, t0 + MAX_SNIPPET_S)


# ------------------------------------------------------------------------------------------------------ pass-set guard

def pass_signature(meta):
    """What must match for two runs to be comparable: the passes that ran and the Gemini models behind them.
    The Whisper model is the variable under test in T6 / T9, so it is reported, not compared."""
    p = meta.get("passes") or {}
    models = meta.get("models") or {}
    return {
        "correction": p.get("correction"),
        "proofread": (p.get("proofread") or {}).get("status"),
        "clips": (p.get("clips") or {}).get("status"),
        "translation": (p.get("translation") or {}).get("status"),
        "geminiFlashLite": models.get("geminiFlashLite"),
        "geminiReasoning": models.get("geminiReasoning"),
        "language": (meta.get("settings") or {}).get("transcriptionLanguage"),
    }


def guard(meta_a, meta_b):
    """None when a (this version) and b (the --vs version, or None for YouTube) may be compared, else the reason."""
    if meta_a is None:
        return "no meta.json for this version"
    if not meta_a.get("completed") or not meta_a.get("passesOk"):
        failed = (meta_a.get("passes") or {}).get("failed")
        return f"this version did not complete with every pass ok (completed={meta_a.get('completed')}, passesOk={meta_a.get('passesOk')}, failed={failed})"
    if meta_b is None:
        return None
    if not meta_b.get("completed") or not meta_b.get("passesOk"):
        return f"the other version did not complete with every pass ok (completed={meta_b.get('completed')}, passesOk={meta_b.get('passesOk')})"
    sa, sb = pass_signature(meta_a), pass_signature(meta_b)
    diff = [f"{k}: {sa[k]} vs {sb[k]}" for k in sa if sa[k] != sb[k]]
    if diff:
        return "pass set or Gemini models differ (" + "; ".join(diff) + ")"
    return None


def asr_note(meta_a, meta_b):
    if not meta_a or not meta_b:
        return None
    a, b = meta_a.get("models") or {}, meta_b.get("models") or {}
    ka, kb = (a.get("whisper"), a.get("whisperOverride")), (b.get("whisper"), b.get("whisperOverride"))
    return None if ka == kb else f"ASR model differs ({ka[1] or ka[0]} vs {kb[1] or kb[0]}): the variable under test"


# ------------------------------------------------------------------------------------------------------ Gemini

def api_key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    try:
        k = read_json(CONFIG).get("geminiApiKey")
    except (OSError, ValueError):
        k = None
    if not k:
        raise ApiFailure(f"no Gemini key: set geminiApiKey in {CONFIG} or GEMINI_API_KEY")
    return k


def call_gemini(parts, key, opener=urllib.request.urlopen, sleep=time.sleep, clock=time.monotonic, total_s=BACKOFF_TOTAL_S):
    """One generateContent call returning the parsed JSON answer. 429 / 5xx / network errors are retried with exponential
    backoff (2 s doubling to 60 s, Retry-After honoured) for up to `total_s`; then ApiFailure."""
    body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseMimeType": "application/json"}}
    req = urllib.request.Request(ENDPOINT % MODEL, json.dumps(body).encode(), {"Content-Type": "application/json", "x-goog-api-key": key})
    started, delay, last = clock(), 2.0, ""
    while True:
        wait = None
        try:
            with opener(req, timeout=600) as r:
                data = json.load(r)
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code not in (429, 500, 502, 503, 504):
                detail = ""
                try:
                    detail = e.read().decode(errors="replace")[:300]
                except Exception:
                    pass
                raise ApiFailure(f"Gemini answered {last}: {detail}") from None
            ra = e.headers.get("Retry-After") if e.headers else None
            wait = float(ra) if ra and ra.replace(".", "", 1).isdigit() else None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = f"network: {e}"
        except (KeyError, IndexError, ValueError) as e:  # no candidate (blocked / empty) or not JSON: usually transient
            last = f"unusable answer ({type(e).__name__})"
        if clock() - started + delay > total_s:
            raise ApiFailure(f"Gemini kept failing for {int(clock() - started)} s (last: {last})")
        sleep(min(max(wait or 0, delay), 60.0))
        delay = min(delay * 2, 60.0)


class Checkpoint:
    """Finished Gemini batches by key, saved after every batch: a rerun with the same inputs skips them."""

    def __init__(self, path):
        self.path = path
        self.data = {"batches": {}, "calls": 0, "audioSeconds": 0.0}
        if path and os.path.exists(path):
            try:
                self.data = read_json(path)
            except (OSError, ValueError):
                log(f"checkpoint {path} unreadable, starting over")
        self.session_calls = 0

    def get(self, key):
        return self.data["batches"].get(key)

    def put(self, key, value, audio_s):
        self.data["batches"][key] = value
        self.data["calls"] += 1
        self.data["audioSeconds"] += audio_s
        self.session_calls += 1
        if self.path:
            write_json(self.path, self.data)


def batch_key(kind, item, payload):
    return hashlib.sha1(json.dumps([kind, MODEL, item, payload], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]


def b64_mp3(wav, t0, t1):
    return base64.b64encode(abtest.cut_mp3(wav, t0, t1 - t0)).decode()


def ask(parts, key, n, **kw):
    """Calls Gemini (once more when the answer lacks items). Returns {item number: answer dict}."""
    by = {}
    for _ in range(2):
        res = call_gemini(parts, key, **kw)
        if isinstance(res, dict):
            res = res.get("results") or res.get("items") or [res]
        by = {r["id"]: r for r in res if isinstance(r, dict) and isinstance(r.get("id"), int)}
        if all(i in by for i in range(n)):
            break
    return by


# ------------------------------------------------------------------------------------------------------ A/B judge

JUDGE_PROMPT = """You are checking {lang} subtitles of a recording against the AUDIO. For each item you get an audio clip and two transcripts (A and B) of roughly that clip; they differ in a few words. Listen and decide which transcript matches what is actually SAID (the words, their forms and endings; ignore punctuation and capitalisation and ignore filler sounds (eh, e, hm: leaving them out is correct); spoken colloquial and dialect forms count as correct, do not "correct" them toward the standard language). Names: the established {lang} spelling is correct. {extra}
Answer per item: "A" or "B" if one matches better, "same" if both are equally right or wrong in the differing words, "neither" if both get the differing words wrong; then give what is said there in "said".
Return a JSON array: [{{"id": N, "verdict": "A"|"B"|"same"|"neither", "said": "<the differing words as spoken>"}}]."""
LANG_EXTRA = {
    "sk": "The speech is Slovak; Czech words appear only when the speaker really switches language.",
    "cs": "The speech is Czech (Czech spelling and forms, not Slovak ones); Slovak words appear only when the speaker really switches language. Colloquial Czech forms (obecná čeština, e.g. 'ten' for 'ty', -ej for -ý) count as correct when said.",
}


def judge_item(item, lang, wav, old_words, new_words, key, ck, max_spans, batch, kw):
    """-> {spans: [... with verdict new / old / same / neither / ? (unjudged)], total, sampled}."""
    all_sp = spans(old_words, new_words)
    sp, sampled = all_sp, False
    if max_spans and len(sp) > max_spans:
        pick = sorted(random.Random(f"judge:{item}").sample(range(len(sp)), max_spans))
        sp, sampled = [sp[i] for i in pick], True
    for k, s in enumerate(sp):
        s["id"] = k
    prompt = JUDGE_PROMPT.format(lang=LANGUAGES.get(lang, lang), extra=LANG_EXTRA.get(lang, ""))
    for b0 in range(0, len(sp), batch):
        chunk = sp[b0:b0 + batch]
        ck_key = batch_key("judge%d" % JUDGE_PROMPT_VERSION, item, [[s["t0"], s["t1"], s["old"], s["new"]] for s in chunk])
        done = ck.get(ck_key)
        if done is None:
            rnd = random.Random(f"{item}:{ck_key}")
            flips = [rnd.random() < 0.5 for _ in chunk]
            parts, audio_s = [{"text": prompt}], 0.0
            for i, s in enumerate(chunk):
                a0, a1 = snippet_range(s)
                audio_s += a1 - a0
                a, b = (s["old"], s["new"]) if flips[i] else (s["new"], s["old"])
                parts += [{"text": f"\nItem {i} audio:"}, {"inline_data": {"mime_type": "audio/mp3", "data": b64_mp3(wav, a0, a1)}},
                          {"text": f"Item {i} A: {a}\nItem {i} B: {b}"}]
            by = ask(parts, key, len(chunk), **kw)
            done = {"flips": flips, "answers": {str(i): by.get(i, {}) for i in range(len(chunk))}}
            ck.put(ck_key, done, audio_s)
        for i, s in enumerate(chunk):
            r = done["answers"].get(str(i)) or {}
            v = r.get("verdict", "?")
            flipped = done["flips"][i]
            s["verdict"] = {"A": "old" if flipped else "new", "B": "new" if flipped else "old"}.get(v, v if v in ("same", "neither") else "?")
            s["said"] = r.get("said", "")
            s["sideA"] = "old" if flipped else "new"
    return {"spans": sp, "total": len(all_sp), "sampled": sampled}


def judge_counts(sp):
    return {v: sum(s["verdict"] == v for s in sp) for v in ("new", "old", "same", "neither", "?")}


# ------------------------------------------------------------------------------------------------------ absolute audit

AUDIT_PROMPT = """You are auditing automatic {lang} subtitles against the AUDIO. Each item is an {sec:g} second clip and the caption words shown for it, numbered. The first or last word may be cut by the clip's edge: ignore those. Listen and mark every caption word that is WRONG, with the type:
- mishearing: a different word was said
- ending: the right word with a wrong grammatical ending or form
- name: a person, place or Bible book spelled wrongly
- number: a number or numeral wrong
- inserted word: the word was not said
- punctuation: punctuation or capitalisation that is clearly wrong (a full stop mid-sentence, a missing question mark); minor taste is not an error
- other
Spoken colloquial and dialect forms count as correct; the established {lang} spelling of names is correct. Filler sounds (eh, e, hm) are not words: never list them as missed. {extra}
Words clearly said but absent from the captions go in "missed" (each as spoken). Words that are right are not listed. A clip with no speech has an empty list.
Return a JSON array: [{{"id": N, "wrong": [{{"i": <word number>, "type": "<type>", "said": "<what was said>"}}], "missed": ["<word>"]}}]."""


def audit_windows(item, duration):
    """Up to 30 distinct fixed 8 s slots, seeded by the item id only: the same audio for every version of the item."""
    n = int(duration // AUDIT_SECONDS)
    if n <= 0:
        return []
    slots = sorted(random.Random(f"audit:{item}").sample(range(n), min(AUDIT_WINDOWS, n)))
    return [round(s * AUDIT_SECONDS, 2) for s in slots]


def window_words(words, t0):
    """Words (text, start, end) whose middle falls inside [t0, t0 + 8)."""
    return [w for w in words if t0 <= (w[1] + w[2]) / 2 < t0 + AUDIT_SECONDS]


def wav_seconds(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def audit_item(item, lang, wav, words, version, key, ck, batch, kw):
    wins = [{"id": i, "t0": t0, "words": window_words(words, t0)} for i, t0 in enumerate(audit_windows(item, wav_seconds(wav)))]
    prompt = AUDIT_PROMPT.format(lang=LANGUAGES.get(lang, lang), sec=AUDIT_SECONDS, extra=LANG_EXTRA.get(lang, ""))
    for b0 in range(0, len(wins), batch):
        chunk = wins[b0:b0 + batch]
        ck_key = batch_key("audit%d" % AUDIT_PROMPT_VERSION, f"{item}:{version}", [[w["t0"], [x[0] for x in w["words"]]] for w in chunk])
        done = ck.get(ck_key)
        if done is None:
            parts = [{"text": prompt}]
            for i, w in enumerate(chunk):
                text = " ".join(f"{k}:{x[0]}" for k, x in enumerate(w["words"])) or "(no caption words)"
                parts += [{"text": f"\nItem {i} audio:"}, {"inline_data": {"mime_type": "audio/mp3", "data": b64_mp3(wav, w["t0"], w["t0"] + AUDIT_SECONDS)}},
                          {"text": f"Item {i} caption words: {text}"}]
            by = ask(parts, key, len(chunk), **kw)
            done = {"answers": {str(i): by.get(i, {}) for i in range(len(chunk))}}
            ck.put(ck_key, done, AUDIT_SECONDS * len(chunk))
        for i, w in enumerate(chunk):
            r = done["answers"].get(str(i)) or {}
            marks = [{"word": x[0], "ok": True} for x in w["words"]]
            for e in r.get("wrong") or []:
                k = e.get("i") if isinstance(e, dict) else None
                if isinstance(k, int) and 0 <= k < len(marks):
                    t = str(e.get("type", "other")).strip().lower()
                    marks[k] = {"word": marks[k]["word"], "ok": False, "type": t if t in ERROR_TYPES else "other", "said": e.get("said", "")}
            w["marks"] = marks
            w["missed"] = [str(m) for m in (r.get("missed") or [])]
            w["answered"] = bool(r)
            w["words"] = [x[0] for x in w["words"]]
    return summarize_audit(wins)


def summarize_audit(wins):
    words = sum(len(w["marks"]) for w in wins)
    by = {t: 0 for t in ERROR_TYPES}
    for w in wins:
        for m in w["marks"]:
            if not m["ok"]:
                by[m["type"]] += 1
        by["dropped word"] += len(w["missed"])
    wrong = sum(by.values())
    denom = words + by["dropped word"]
    return {"windows": wins, "words": words, "wrong": wrong, "byType": by, "rate": wrong / denom if denom else None,
            "unanswered": sum(not w["answered"] for w in wins)}


# ------------------------------------------------------------------------------------------------------ heavy jobs (VAD, reference)

HELPER = r'''
import sys, json
sys.path.insert(0, sys.argv[1])
import transcribe as T
mode = sys.argv[2]
if mode == "vad":
    import whisperx
    audio = whisperx.load_audio(sys.argv[3])
    json.dump({"turns": [[s, e] for s, e in T.speech_turns(audio)], "seconds": len(audio) / 16000}, open(sys.argv[4], "w"))
elif mode == "text":
    texts = json.load(sys.stdin)
    json.dump([{"stock": T.is_stock_phrase(t), "loop": T.is_loop(t)} for t in texts], sys.stdout)
elif mode == "ref":
    import unicodedata as u
    import whisperx, mlx_whisper
    import mlx.core as mx
    mx.set_cache_limit(512 * 2**20)
    n = lambda w: "".join(c for c in u.normalize("NFD", w.lower()) if c.isalnum())
    audio = whisperx.load_audio(sys.argv[3]); turns = [tuple(t) for t in json.load(open(sys.argv[5]))["turns"]]
    ref = []
    for s, t in T.join_turns(turns):
        s, t = max(0, s - 0.2), t + 0.2
        r = mlx_whisper.transcribe(audio[int(s * 16000):int(t * 16000)], path_or_hf_repo=T.MLX_MODELS["large-v3-turbo"], language=sys.argv[6],
                                   condition_on_previous_text=False, word_timestamps=True, verbose=None)
        mx.clear_cache()
        ref += [[s + w["start"], s + w["end"], w["word"]] for seg in r["segments"] for w in seg.get("words", []) if n(w["word"])]
    json.dump(ref, open(sys.argv[4], "w"))
'''


def run_helper(*args, stdin=None, timeout=None):
    r = subprocess.run([MANAGED_PYTHON, "-I", "-c", HELPER, SCRIPTS, *map(str, args)], input=stdin, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"managed python helper {args[0]} failed: {r.stderr[-600:]}")
    return r.stdout


HEAVY = re.compile(r"(transcribe|track_speaker)\.py\b|(^|/)remotion(\s|$)|@remotion/compositor\S*/remotion\b")


def heavy_jobs_running(ps_lines=None):
    """Heavy jobs on this Mac: the pipeline's Python helpers, the framing tracker, a Remotion render."""
    if ps_lines is None:
        ps_lines = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout.splitlines()
    out = []
    for line in ps_lines:
        pid, _, cmd = line.strip().partition(" ")
        if pid == str(os.getpid()) or "report.py" in cmd or "claude" in cmd.split(" ")[0].lower():
            continue
        if HEAVY.search(cmd):
            out.append(line.strip()[:160])
    return out


LOCK_FILE = os.path.join(CORPUS, ".lock")


class LockHeld(Exception):
    def __init__(self, holder):
        super().__init__(f"lock held by {holder.get('tool', '?')} (pid {holder.get('pid', '?')}, since {holder.get('startedAt', '?')})")
        self.holder = holder


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def acquire_lock(tool="report.py", path=LOCK_FILE):
    """Same file and format as lock.ts ({pid, startedAt, tool}, created atomically; a dead holder's lock is stale).
    Returns the release function or raises LockHeld."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    info = json.dumps({"pid": os.getpid(), "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "tool": tool})
    for _ in range(3):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                f.write(info)

            def release():
                try:
                    if read_json(path).get("pid") == os.getpid():
                        os.remove(path)
                except (OSError, ValueError):
                    pass
            return release
        except FileExistsError:
            pass
        try:
            holder = read_json(path)
        except (OSError, ValueError):
            holder = {}
        if isinstance(holder.get("pid"), int) and pid_alive(holder["pid"]):
            raise LockHeld(holder)
        try:
            os.remove(path)
        except OSError:
            pass
    raise LockHeld({})


def take_heavy_slot(wait_s, lock_path=LOCK_FILE, poll=30.0, sleep=time.sleep):
    """Waits until no heavy job runs and the lock is free (up to wait_s), then holds the lock. Returns the release function."""
    started = time.monotonic()
    while True:
        busy = heavy_jobs_running()
        if not busy:
            try:
                release = acquire_lock(path=lock_path)
                if not heavy_jobs_running():  # a job may have started between the check and the lock
                    return release
                release()
            except LockHeld as e:
                busy = [str(e)]
        if time.monotonic() - started > wait_s:
            raise SystemExit(f"a heavy job is still running after {int(wait_s)} s: {busy[0] if busy else '?'}")
        log(f"waiting for a heavy job to finish: {busy[0] if busy else 'lock'}")
        sleep(poll)


def vad_turns(item, wav, cache_dir):
    """Cached VAD speech turns (transcribe.py's speech_turns), or None when not cached or the audio changed."""
    try:
        d = read_json(os.path.join(cache_dir, item, "vad.json"))
        st = os.stat(wav)
        if d.get("wavBytes") == st.st_size and d.get("wavMtime") == int(st.st_mtime):
            return d["turns"]
    except (OSError, ValueError, KeyError):
        pass
    return None


def compute_vad(item, wav, cache_dir):
    d = os.path.join(cache_dir, item)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, "vad.tmp.json")
    run_helper("vad", wav, tmp)
    out = read_json(tmp)
    st = os.stat(wav)
    out.update({"wavBytes": st.st_size, "wavMtime": int(st.st_mtime), "source": "server/scripts/transcribe.py speech_turns",
                "createdAt": datetime.datetime.now().isoformat(timespec="seconds")})
    write_json(os.path.join(d, "vad.json"), out)
    os.remove(tmp)
    return out["turns"]


def compute_ref(item, wav, lang, cache_dir):
    """mlx-whisper word-timestamp reference pass (base turbo) on the VAD chunks, cached per item and language."""
    d = os.path.join(cache_dir, item)
    p = os.path.join(d, f"ref_words_{lang}.json")
    tmp = p + ".tmp"
    run_helper("ref", wav, tmp, os.path.join(d, "vad.json"), lang)
    os.replace(tmp, p)
    return read_json(p)


def text_hits(texts):
    """Stock-phrase / loop flags per text from transcribe.py's own functions (managed python); None when unavailable."""
    if not texts:
        return []
    if not os.path.exists(MANAGED_PYTHON):
        return None
    try:
        return json.loads(run_helper("text", stdin=json.dumps(texts, ensure_ascii=False), timeout=120))
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as e:
        log(f"stock/loop check unavailable: {e}")
        return None


# ------------------------------------------------------------------------------------------------------ dropped speech

def merge_intervals(iv):
    out = []
    for s, e in sorted(iv):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def holes(turns, words, margin=HOLE_MARGIN_S, min_s=LOST_MIN_S):
    """Stretches of VAD speech turns that no caption word covers (a word covers its own time +- margin), >= min_s long."""
    cover = merge_intervals([(w[1] - margin, w[2] + margin) for w in words])
    out = []
    for s, e in turns:
        pos = s
        for a, b in cover:
            if b <= pos or a >= e:
                continue
            if a - pos >= min_s:
                out.append((pos, a))
            pos = max(pos, b)
            if pos >= e:
                break
        if e - pos >= min_s:
            out.append((pos, e))
    return out


def split_masked(hole_list, masks, pad=1.0, min_s=LOST_MIN_S):
    """-> (lost holes, masked seconds by kind). A hole is cut by the sound-tag stretches (padded by `pad` s); what is left is
    lost speech when it is still >= min_s long, the rest was masked."""
    lost, masked = [], {"music": 0.0, "sound": 0.0}
    for s, e in hole_list:
        pieces = [[s, e]]
        for m in masks:
            a, b = m["t0"] - pad, m["t1"] + pad
            nxt = []
            for x, y in pieces:
                if b <= x or a >= y:
                    nxt.append([x, y])
                    continue
                masked[m["kind"]] += min(y, b) - max(x, a)
                if a > x:
                    nxt.append([x, a])
                if y > b:
                    nxt.append([b, y])
            pieces = nxt
        lost += [(x, y) for x, y in pieces if y - x >= min_s]
    return lost, masked


def dropped_speech(turns, words, masks):
    h = holes(turns, words)
    lost, masked = split_masked(h, masks)
    return {"turns": len(turns), "speechSeconds": round(sum(e - s for s, e in turns), 1),
            "holes": [[round(a, 2), round(b, 2)] for a, b in h],
            "lost": [[round(a, 2), round(b, 2)] for a, b in lost], "lostSeconds": round(sum(b - a for a, b in lost), 1),
            "maskedMusicSeconds": round(masked["music"], 1), "maskedSoundSeconds": round(masked["sound"], 1)}


def stock_loop_hits(words, cues):
    """Where transcribe.py's is_stock_phrase / is_loop fire: stock phrases on every cue text and every sentence of the words,
    loops on sliding 40-word groups. -> {"stock": [...], "loop": [...]} or None when the managed Python is unavailable."""
    sentences, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.!?]$", w[0]):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)
    groups = [words[i:i + 40] for i in range(0, max(1, len(words) - 20), 20)] if words else []
    items = ([(c[0], c[2]) for c in cues] + [(s[0][1], " ".join(w[0] for w in s)) for s in sentences]
             + [(g[0][1], " ".join(w[0] for w in g)) for g in groups])
    flags = text_hits([t for _, t in items])
    if flags is None:
        return None
    out = {"stock": [], "loop": []}
    for f, (t, text) in zip(flags, items):
        for kind in ("stock", "loop"):
            if f[kind] and not any(abs(h["t"] - t) < 30 and h["text"][:30] == text[:30] for h in out[kind]):
                out[kind].append({"t": round(t, 1), "text": text[:100]})
    return out


# ------------------------------------------------------------------------------------------------------ word timing

def lag_stats(lags):
    """Distribution of caption start minus reference start (seconds; positive = the caption is late)."""
    xs = [x[0] if isinstance(x, (tuple, list)) else x for x in lags]
    if not xs:
        return {"n": 0}
    return {"n": len(xs), "median": round(quantile(xs, .5), 3), "p10": round(quantile(xs, .1), 3), "p90": round(quantile(xs, .9), 3),
            "p95": round(quantile(xs, .95), 3), "lateOver": sum(x > TIMING_TH for x in xs), "earlyOver": sum(x < -TIMING_TH for x in xs)}


def vad_lags(words, turns):
    """Lag of the first caption word of each speech turn that follows a pause of at least 0.4 s, against the turn's start:
    [(lag, turn start, word)]. A turn with no word is the dropped-speech section's business; a word that began long before the
    turn (one spanning it) is skipped."""
    out, j = [], 0
    for k, (s, e) in enumerate(turns):
        if k and s - turns[k - 1][1] < 0.4:
            continue
        while j < len(words) and words[j][2] <= s + 0.05:
            j += 1
        if j >= len(words) or words[j][1] >= e or words[j][1] < s - 0.5:
            continue
        out.append((words[j][1] - s, s, words[j][0]))
    return out


def match_lags(sub, ref, min_block=3):
    """sub: [(text, start)], ref: [(start, end, text)] -> {sub index: caption start - ref start} for words inside a run of
    >= min_block matching words (a lone match can be the same word elsewhere), as timing.py does."""
    sm = difflib.SequenceMatcher(None, [abtest.norm(x[0]) for x in sub], [abtest.norm(r[2]) for r in ref], autojunk=False)
    out = {}
    for a, b, size in sm.get_matching_blocks():
        if size >= min_block:
            for k in range(size):
                out[a + k] = sub[a + k][1] - ref[b + k][0]
    return out


def ref_lags(words, cues, ref):
    onset = match_lags([(w[0], w[1]) for w in words], ref)
    flat, first = [], []
    for c in cues:
        toks = [w for w in c[2].split() if abtest.norm(w)]
        if toks:
            first.append(len(flat))
        flat += [(w, c[0]) for w in toks]
    cm = match_lags(flat, ref)
    return {"onset": [onset[i] for i in sorted(onset)], "cueStart": [cm[i] for i in first if i in cm]}


# ------------------------------------------------------------------------------------------------------ layout

ABBREV = {"cs": {"např", "tzv", "atd", "tzn", "apod", "resp", "tj", "sv", "kap", "př", "mj", "cca", "str", "tel", "č", "t", "j", "p", "n", "l", "o", "mr", "dr", "st"},
          "sk": {"tzv", "napr", "atď", "resp", "tj", "t", "j", "p", "sv", "str", "č", "kap", "porov", "pozn", "mr", "dr", "st", "zák", "kr", "n", "l", "o"}}
STOP = re.compile(r"(\S+)\.\s+(?=(\S+))")
QUESTION = re.compile(r"\?\s+(\S+)")


def starts_lower(w):
    for c in w:
        if c.isalpha():
            return c.islower()
        if c.isdigit():
            return False
    return False


def layout(cues, lang):
    """Layout problems of an SRT's cues [(start, end, text with \\n line breaks)]: each key lists its hits."""
    abbr = ABBREV.get(lang, ABBREV["sk"])
    out = {"over7s": [], "longLines": [], "oneLetterEnds": [], "midSentenceStops": [], "questionLower": []}
    for s, e, text in cues:
        if e - s > MAX_CUE_S:
            out["over7s"].append({"t": round(s, 1), "dur": round(e - s, 1)})
        for ln in text.split("\n"):
            if len(ln) > MAX_LINE:
                out["longLines"].append({"t": round(s, 1), "len": len(ln), "text": ln})
            toks = ln.split()
            if toks:
                last = toks[-1].lower().strip(",.")
                if len(last) == 1 and last.isalpha():
                    out["oneLetterEnds"].append({"t": round(s, 1), "text": ln})
    flat, starts, pos = [], [], 0
    for s, e, text in cues:
        t = text.replace("\n", " ")
        starts.append((pos, s))
        flat.append(t)
        pos += len(t) + 1
    flat = " ".join(flat)

    def at(i):
        t = 0.0
        for p, s in starts:
            if p > i:
                break
            t = s
        return round(t, 1)
    for m in STOP.finditer(flat):
        prev, nxt = m.group(1), m.group(2)
        if prev.endswith("..") or prev.rstrip(".").isdigit() or prev.rstrip(".").lower() in abbr or not starts_lower(nxt):
            continue
        out["midSentenceStops"].append({"t": at(m.start()), "text": f"{prev}. {nxt}"})
    for m in QUESTION.finditer(flat):
        if starts_lower(m.group(1)):
            out["questionLower"].append({"t": at(m.start()), "text": flat[max(0, m.start() - 20):m.end()]})
    return out


def layout_counts(cues, lang):
    detail = layout(cues, lang)
    return {"cues": len(cues), **{k: len(v) for k, v in detail.items()}}, detail


# ------------------------------------------------------------------------------------------------------ loading

def item_files(it, manifest_path):
    base = os.path.dirname(os.path.abspath(manifest_path))
    paths = it.get("paths") or {}

    def res(p):
        p = os.path.expanduser(p)
        return p if os.path.isabs(p) else os.path.join(base, p)
    wav = res(it.get("wav") or paths.get("audioWav") or os.path.join(it["id"], "audio.wav"))
    yt = res(paths.get("captionsSrt") or os.path.join(it["id"], "youtube_auto.srt"))
    if not os.path.exists(yt):
        alt = os.path.join(CORPUS, it["id"], "youtube_auto.srt")
        yt = alt if os.path.exists(alt) else None
    return wav, yt


def read_version(runs, version, item, lang):
    d = os.path.join(runs, version, item)

    def exists(n):
        return os.path.exists(os.path.join(d, n))
    meta = read_json(os.path.join(d, "meta.json")) if exists("meta.json") else None
    srt_text = open(os.path.join(d, f"captions_{lang}.srt"), encoding="utf-8-sig").read() if exists(f"captions_{lang}.srt") else None
    words = None
    if exists("transcript.json"):
        words = [(w["word"], w["startMs"] / 1000, w["endMs"] / 1000) for w in read_json(os.path.join(d, "transcript.json")).get("words", []) if abtest.norm(w["word"])]
    return {"meta": meta, "cues": abtest.parse_srt(srt_text) if srt_text else None, "words": words, "srtText": srt_text, "dir": d}


def cues_with_lines(srt_text):
    """[(start, end, text with the cue's line breaks as \\n)] for the layout checks."""
    out = []
    for block in srt_text.replace("\r", "").lstrip("﻿").strip().split("\n\n"):
        lines = block.split("\n")
        m = re.findall(r"(\d+):(\d+):(\d+)[,.](\d+)", lines[1] if len(lines) > 1 else "")
        if len(m) == 2:
            t = [int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000 for h, mi, s, ms in m]
            out.append((t[0], t[1], "\n".join(lines[2:]).strip()))
    return out


# ------------------------------------------------------------------------------------------------------ report

def md_table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def render(R):
    L = [f"# Quality report: {R['name']}\n"]
    g = R["gemini"]
    L.append(f"Generated {R['generatedAt']}. Version `{R['version']}`" + (f" against `{R['vs']}`" if R["vs"] else "")
             + f". Judge and audit model `{MODEL}`; {g['calls']} Gemini calls in this report's checkpoint ({g['sessionCalls']} this run, "
             f"about {g['audioSeconds'] / 60:.0f} min of audio sent).\n")
    L.append(md_table(["item", "language", "set", "commit", "Whisper", "audio"],
                      [[i, d["language"], d["set"], (d.get("commit") or "")[:7], d.get("whisper") or "?",
                        f"{d['audioSeconds'] / 60:.1f} min" if d.get("audioSeconds") else "?"] for i, d in R["items"].items()]))
    L.append("\n## 1. Pass-set guard\n")
    L.append(md_table(["item", "A/B comparison", "reason"],
                      [[i, "ok" if d["guard"] is None else "**refused**", d["guard"] or d["asrNote"] or "passes and Gemini models match"]
                       for i, d in R["items"].items()]))
    L.append("\nAn item whose run did not complete with every pass ok (`passesOk`), or whose passes or Gemini models differ from the other "
             "version's, is not judged against it. YouTube has no meta.json: it is compared only when this run's own passes are ok. "
             "A different Whisper model is not a refusal (it is the variable under test) but is stated.\n")

    L.append("## 2. A/B listening judge\n")
    if not R["vs"]:
        L.append("Not run: needs `--vs <version|youtube>`.\n")
    else:
        L.append(f"A = this version (`{R['version']}`, \"new\"), B = `{R['vs']}` (\"old\"). The judge hears each span where the two SRTs' words differ "
                 "(diacritics kept; punctuation, case, YouTube sound tags and `>>` markers ignored); the sides are shuffled.\n")
        rows, tot, nspans = [], {"new": 0, "old": 0, "same": 0, "neither": 0, "?": 0}, 0
        for i, d in R["items"].items():
            j = d.get("judge")
            if not j:
                rows.append([i, "-", "-", "-", "-", "-", "-", "refused (see 1)" if d["guard"] else "not run"])
                continue
            c = j["counts"]
            nspans += len(j["spans"])
            for k in tot:
                tot[k] += c[k]
            note = f"net {c['new'] - c['old']:+d}" + (f"; sampled {len(j['spans'])} of {j['total']} spans" if j["sampled"] else "")
            rows.append([i, len(j["spans"]), c["new"], c["old"], c["same"], c["neither"], c["?"], note])
        if len(rows) > 1:
            rows.append(["**all**", nspans, tot["new"], tot["old"], tot["same"], tot["neither"], tot["?"], f"net {tot['new'] - tot['old']:+d}"])
        L.append(md_table(["item", "spans", "new better", "old better", "same", "both wrong", "unjudged", "note"], rows))
        L.append("")
        for i, d in R["items"].items():
            j = d.get("judge")
            if not j:
                continue
            bad = [s for s in j["spans"] if s["verdict"] in ("old", "neither")]
            L.append(f"### {i}: {len(bad)} spans where the old side is better or both are wrong\n")
            for s in bad:
                L.append(f"- {fmt_t(s['dt'])} (span {fmt_t(s['t0'])}-{fmt_t(s['t1'])}) **{'old better' if s['verdict'] == 'old' else 'both wrong'}**: "
                         f"new `{s['new_diff'] or '(nothing)'}` | old `{s['old_diff'] or '(nothing)'}` | said `{s['said']}`")
            L.append("")

    L.append("## 3. Absolute audit\n")
    if not any(d.get("audit") for d in R["items"].values()):
        L.append("Not run.\n")
    else:
        L.append(f"{AUDIT_WINDOWS} fixed {AUDIT_SECONDS:g} s windows per item (seeded by the item id: the same audio for every version). Gemini hears each window "
                 "and marks every caption word right or wrong; words it hears that the captions lack count as `dropped word`. "
                 "Error rate = errors / (caption words + dropped words). A window with singing or music can inflate `dropped word`.\n")
        rows = []
        for i, d in R["items"].items():
            for ver, a in (d.get("audit") or {}).items():
                bt = a["byType"]
                rows.append([i, ver, a["words"], a["wrong"], pct(a["wrong"], a["words"] + bt["dropped word"])] + [bt[t] for t in ERROR_TYPES] + [a["unanswered"] or ""])
        L.append(md_table(["item", "version", "words", "errors", "rate"] + ERROR_TYPES + ["unanswered windows"], rows))
        L.append("")

    L.append("## 4. Dropped speech\n")
    L.append(f"Stretches of VAD speech (`transcribe.py` `speech_turns`) of at least {LOST_MIN_S:g} s that no caption word covers (word time +- {HOLE_MARGIN_S} s). "
             "Stretches a YouTube sound-tag cue covers (+-1 s) are **masked/music seconds** (or other sound for [potlesk] and the like), not lost speech. "
             "Stock phrases and repetition loops are `transcribe.py`'s `is_stock_phrase` / `is_loop` on the caption words.\n")
    rows = []
    for i, d in R["items"].items():
        x = d.get("dropped")
        if not x:
            rows.append([i, "-", "-", "-", "-", "-", "-", "-"])
            continue
        h = x.get("hits")
        rows.append([i, f"{x['speechSeconds'] / 60:.1f} min", len(x["lost"]), f"{x['lostSeconds']:.1f}", f"{x['maskedMusicSeconds']:.1f}",
                     f"{x['maskedSoundSeconds']:.1f}", len(h["stock"]) if h else "n/a", len(h["loop"]) if h else "n/a"])
    L.append(md_table(["item", "VAD speech", "lost holes", "lost seconds", "masked music s", "masked other sound s", "stock phrases", "loops"], rows))
    L.append("")
    for i, d in R["items"].items():
        x = d.get("dropped")
        if not x:
            continue
        hits = x.get("hits") or {}
        lines = [f"- lost {fmt_t(a)}-{fmt_t(b)} ({b - a:.1f} s)" for a, b in x["lost"][:25]]
        lines += [f"- stock phrase at {fmt_t(h['t'])}: {h['text']}" for h in hits.get("stock", [])[:10]]
        lines += [f"- loop at {fmt_t(h['t'])}: {h['text']}" for h in hits.get("loop", [])[:10]]
        if lines:
            L.append(f"### {i}\n")
            L += lines
            if len(x["lost"]) > 25:
                L.append(f"- ... {len(x['lost']) - 25} more lost holes in the JSON")
            L.append("")

    L.append("## 5. Word timing\n")
    L.append(f"Lag = caption start minus reference start (positive: late). **VAD lag**: the first caption word of each speech turn that follows a pause of at least 0.4 s, "
             f"against the turn's start. **Reference lag** (only with `--ref`): word onsets and cue starts against an independent mlx-whisper (base turbo) word-timestamp pass "
             f"on the VAD chunks, matched in runs of 3+ words. Flagged: |lag| > {TIMING_TH} s.\n")
    rows = []
    for i, d in R["items"].items():
        t = d.get("timing") or {}
        for label, st in (("VAD lag, turn starts", t.get("vad")), ("ref lag, word onsets", t.get("onset")), ("ref lag, cue starts", t.get("cueStart"))):
            if st and st.get("n"):
                rows.append([i, label, st["n"], st["median"], st["p10"], st["p90"], st["p95"],
                             f"{st['lateOver']} ({pct(st['lateOver'], st['n'])})", f"{st['earlyOver']} ({pct(st['earlyOver'], st['n'])})"])
    L.append(md_table(["item", "measure", "n", "median s", "p10", "p90", "p95", f"late > {TIMING_TH} s", f"early > {TIMING_TH} s"], rows) if rows
             else "No timing data (VAD not available or skipped).")
    if not any((d.get("timing") or {}).get("onset") for d in R["items"].values()):
        L.append("\nThe mlx-whisper reference pass was not run for this report (pass `--ref`; about as heavy as a transcription), so only the VAD lag is reported.")
    L.append("")

    L.append("## 6. Layout\n")
    rows = [[i, ver, c["cues"], c["over7s"], c["longLines"], c["oneLetterEnds"], c["midSentenceStops"], c["questionLower"]]
            for i, d in R["items"].items() for ver, c in (d.get("layout") or {}).items()]
    L.append(md_table(["item", "version", "cues", "cues > 7 s", f"lines > {MAX_LINE}", "line ends on 1-letter word", "mid-sentence stops", "'?' + lower case"], rows))
    L.append("")

    L.append("## 7. Speed and memory\n")
    rows = []
    for i, d in R["items"].items():
        m = d.get("speed")
        if m:
            a = m.get("audioSeconds")
            rows.append([i, f"{a / 60:.1f} min" if a else "?", m.get("transcribe"), m.get("gemini"), m.get("total"),
                         f"{m['total'] / a:.2f}x" if m.get("total") and a else "?", m.get("peakRssPythonMb")])
    L.append(md_table(["item", "audio", "transcribe s", "gemini s", "total s", "total / audio", "peak RSS MB (Python helper)"], rows))
    L.append("\nPeak RSS is sampled from `ps` and undercounts MLX's Metal buffers: use it to compare runs, not as the footprint.\n")
    return "\n".join(L)


# ------------------------------------------------------------------------------------------------------ main

def main(argv=None):
    ap = argparse.ArgumentParser(description="quality report for a run version")
    ap.add_argument("version")
    ap.add_argument("--vs", help="another run version, or 'youtube'")
    ap.add_argument("--items", nargs="+")
    ap.add_argument("--manifest", default=os.path.join(CORPUS, "manifest.json"))
    ap.add_argument("--runs", default=os.path.join(CORPUS, "runs"))
    ap.add_argument("--out", default=os.path.join(CORPUS, "reports"))
    ap.add_argument("--skip", default="", help="comma list of judge,audit,vad,timing,layout")
    ap.add_argument("--ref", action="store_true", help="also run the mlx-whisper word-timestamp reference pass (heavy, cached per item)")
    ap.add_argument("--max-spans", type=int, default=120, help="judge at most this many spans per item (seeded sample); 0 = all")
    ap.add_argument("--batch", type=int, default=BATCH)
    ap.add_argument("--wait-hours", type=float, default=3.0, help="how long to wait for a running heavy job")
    ap.add_argument("--corpus-cache", default=CORPUS, help="where <id>/vad.json and ref_words_<lang>.json are cached")
    args = ap.parse_args(argv)
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    manifest_path = os.path.expanduser(args.manifest)
    runs, out_dir = os.path.expanduser(args.runs), os.path.expanduser(args.out)
    manifest = abtest.load_manifest(manifest_path)
    vs_youtube = args.vs == "youtube"
    vdir = os.path.join(runs, args.version)
    items = args.items or sorted(i for i in (os.listdir(vdir) if os.path.isdir(vdir) else []) if os.path.exists(os.path.join(vdir, i, "meta.json")))
    if not items:
        print(f"no items: {vdir} has none", file=sys.stderr)
        return 2
    for i in items:
        if i not in manifest:
            print(f"{i}: not in the manifest {manifest_path}", file=sys.stderr)
            return 2
    os.makedirs(out_dir, exist_ok=True)
    name = args.version + (f"-vs-{args.vs}" if args.vs else "")
    ck = Checkpoint(os.path.join(out_dir, f"{name}.checkpoint.json"))
    R = {"name": name, "version": args.version, "vs": args.vs, "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"), "model": MODEL, "items": {}}
    key, kw, contested = None, {}, []
    try:
        if ("judge" not in skip and args.vs) or "audit" not in skip:
            key = api_key()
    except ApiFailure as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 3

    # ---- load everything and run the pass-set guard
    ctx = {}
    for item in items:
        it = manifest[item]
        lang = it["language"]
        wav, yt = item_files(it, manifest_path)
        A = read_version(runs, args.version, item, lang)
        B = None if vs_youtube or not args.vs else read_version(runs, args.vs, item, lang)
        if A["cues"] is None or A["words"] is None:
            reason = f"captions_{lang}.srt or transcript.json missing in {A['dir']}"
        else:
            reason = guard(A["meta"], B["meta"] if B else None)
        if not reason and B and (B["cues"] is None or B["words"] is None):
            reason = f"the other version has no captions_{lang}.srt / transcript.json"
        if not reason and vs_youtube and not yt:
            reason = "no youtube_auto.srt for this item"
        meta = A["meta"] or {}
        models = meta.get("models") or {}
        R["items"][item] = {"language": lang, "set": it.get("set"), "commit": (meta.get("git") or {}).get("commit"),
                            "whisper": models.get("whisperOverride") or models.get("whisper"), "audioSeconds": meta.get("audioSeconds"),
                            "guard": reason, "asrNote": asr_note(A["meta"], B["meta"]) if B else None}
        ctx[item] = {"lang": lang, "wav": wav, "yt": yt, "A": A, "B": B}
        if reason:
            log(f"{item}: {reason}")

    # ---- heavy jobs first (VAD, reference): one slot for all items
    wanted = {i: c for i, c in ctx.items() if c["A"]["words"] is not None and os.path.exists(c["wav"]) and ({"vad", "timing"} - skip)}
    todo = [i for i, c in wanted.items() if vad_turns(i, c["wav"], args.corpus_cache) is None]
    todo_ref = [i for i, c in wanted.items() if args.ref and "timing" not in skip
                and not os.path.exists(os.path.join(args.corpus_cache, i, f"ref_words_{c['lang']}.json"))]
    if (todo or todo_ref) and not os.path.exists(MANAGED_PYTHON):
        log(f"managed Python not found at {MANAGED_PYTHON}: the VAD-based sections are skipped")
        todo, todo_ref = [], []
    if todo or todo_ref:
        release = take_heavy_slot(args.wait_hours * 3600)
        try:
            for i in todo:
                log(f"{i}: VAD ...")
                compute_vad(i, wanted[i]["wav"], args.corpus_cache)
            for i in todo_ref:
                log(f"{i}: reference word timestamps ...")
                compute_ref(i, wanted[i]["wav"], wanted[i]["lang"], args.corpus_cache)
        finally:
            release()

    # ---- per item
    try:
        for item, c in ctx.items():
            d, lang, A, B = R["items"][item], c["lang"], c["A"], c["B"]
            if A["words"] is None or A["cues"] is None:
                continue
            masks, yt_cues = [], None
            if c["yt"]:
                yt_cues, masks = youtube_cues(c["yt"])
            d["layout"], d["layoutDetail"] = {}, {}
            if "layout" not in skip:
                d["layout"][args.version], d["layoutDetail"][args.version] = layout_counts(cues_with_lines(A["srtText"]), lang)
                if B and B["srtText"]:
                    d["layout"][args.vs], d["layoutDetail"][args.vs] = layout_counts(cues_with_lines(B["srtText"]), lang)
            m = A["meta"] or {}
            d["speed"] = dict(m.get("timingsSeconds") or {}, peakRssPythonMb=m.get("peakRssPythonMb"), audioSeconds=m.get("audioSeconds"))
            if "judge" not in skip and args.vs and not d["guard"]:
                old_words = cue_words(yt_cues if vs_youtube else B["cues"])
                j = judge_item(item, lang, c["wav"], old_words, cue_words(A["cues"]), key, ck, args.max_spans, args.batch, kw)
                j["counts"] = judge_counts(j["spans"])
                d["judge"] = j
                contested += [{"item": item, "t0": s["t0"], "t1": s["t1"], "verdict": "worse" if s["verdict"] == "old" else "both wrong",
                               "new": s["new_diff"], "old": s["old_diff"], "said": s["said"]} for s in j["spans"] if s["verdict"] in ("old", "neither")]
                cn = j["counts"]
                log(f"{item}: {len(j['spans'])} spans, new {cn['new']} old {cn['old']} same {cn['same']} both wrong {cn['neither']} unjudged {cn['?']}")
            if "audit" not in skip and os.path.exists(c["wav"]):
                d["audit"] = {args.version: audit_item(item, lang, c["wav"], A["words"], args.version, key, ck, args.batch, kw)}
                if B and B["words"] and not d["guard"]:
                    d["audit"][args.vs] = audit_item(item, lang, c["wav"], B["words"], args.vs, key, ck, args.batch, kw)
                a = d["audit"][args.version]
                log(f"{item}: audit {a['wrong']} errors in {a['words']} words")
            turns = vad_turns(item, c["wav"], args.corpus_cache) if os.path.exists(c["wav"]) else None
            if turns is not None and "vad" not in skip:
                d["dropped"] = dropped_speech(turns, A["words"], masks)
                d["dropped"]["hits"] = stock_loop_hits(A["words"], A["cues"])
            if turns is not None and "timing" not in skip:
                lags = vad_lags(A["words"], turns)
                d["timing"] = {"vad": lag_stats(lags), "vadWorst": [[round(x[0], 2), round(x[1], 2), x[2]] for x in sorted(lags, key=lambda x: -abs(x[0]))[:10]]}
                refp = os.path.join(args.corpus_cache, item, f"ref_words_{lang}.json")
                if args.ref and os.path.exists(refp):
                    r = ref_lags(A["words"], A["cues"], read_json(refp))
                    d["timing"]["onset"], d["timing"]["cueStart"] = lag_stats(r["onset"]), lag_stats(r["cueStart"])
    except ApiFailure as e:
        log(f"\nFAILED: {e}\nNothing was written; the finished batches are kept in {ck.path}: run the same command again to resume.")
        return 3

    R["gemini"] = {"calls": ck.data["calls"], "sessionCalls": ck.session_calls, "audioSeconds": ck.data["audioSeconds"]}
    base = os.path.join(out_dir, name)
    write_json(base + ".json", R)
    with open(base + ".md", "w", encoding="utf-8") as f:
        f.write(render(R) + "\n")
    if args.vs:
        write_json(base + ".contested.json", contested)
    print(f"wrote {base}.md (+ .json{', .contested.json' if args.vs else ''}); {ck.session_calls} Gemini calls this run, {ck.data['calls']} in total")
    return 0


if __name__ == "__main__":
    sys.exit(main())

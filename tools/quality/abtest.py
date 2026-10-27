#!/usr/bin/env python3
"""abtest.py: blind A/B listening test for two caption versions of corpus items (sk or cs).

  python3 -I tools/quality/abtest.py build <versionA> <versionB> <item...> [--windows 20] [--seconds 25]
                                           [--contested <json>] [--out <dir>] [--manifest <path>] [--seed N]
  python3 -I tools/quality/abtest.py unblind <out-dir> <votes.json>

build   reads the manifest (language, audio.wav per item) and the SRTs
        <runs>/<version>/<item>/captions_<lang>.srt, finds the spans where the two versions' words differ
        (case and punctuation ignored, diacritics kept), picks the windows (half from the spans the judge marked worse / both wrong
        when --contested is given, the rest random, seeded), cuts MP3 snippets with ffmpeg, shuffles which version
        is A per window and writes <out>/abtest.html (self-contained, audio embedded) and <out>/key.json (the answer key).
unblind prints the tally per version with a 95 % Wilson interval and the per-window verdicts.

The page carries no version name; key.json is the only place that maps A/B to versions. Keep it local.
Python 3 standard library and ffmpeg only.
"""
import argparse
import base64
import difflib
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.expanduser("~/LuskCorpus")
PRE = 0.6          # lead-in before a window's first cue
RETRIES = 6        # tries per span with a different window offset
MERGE_GAP = 3      # differences this many words apart are one span
CONTEXT = 6        # words of context around a span
BAD_VERDICTS = {"worse", "old", "neither", "both wrong", "both_wrong", "bothwrong", "both-wrong"}

LABELS = {
    "sk": {
        "title": "Slepý test titulkov", "window": "Úryvok",
        "sub": "Každý úryvok prehrá niekoľko sekúnd zvuku s dvoma verziami titulkov, A a B, v náhodnom poradí. Počúvajte, čítajte a vyberte tú, ktorú by ste radšej zverejnili. Slová, ktoré sa líšia, sú zvýraznené.",
        "marks": "Zvýrazniť rozdiely", "aBetter": "A je lepšie", "same": "Približne rovnaké", "bBetter": "B je lepšie",
        "notePh": "Voliteľne: čo rozhodlo (zlé slovo, chýbajúca reč, príliš rýchly titulok…)",
        "copy": "Kopírovať hlasy ako JSON", "next": "Ďalší úryvok →", "copied": "Skopírované",
        "ready": "Pripravené", "saving": "Ukladám…", "saved": "Uložené",
        "saveFailed": "Nepodarilo sa uložiť. Skúste hlasovať znova.",
        "notSaved": "Neuložené: hlasy sa ukladajú len pri otvorení v claude.ai. Použite „Kopírovať hlasy ako JSON“.",
        "lost": "Spojenie s uloženými hlasmi sa stratilo. Načítajte stránku znova.",
        "doneSaved": "Ohodnotených všetkých {n} úryvkov. Odpovede sú uložené; povedzte Claudovi, že ste hotový.",
        "doneCopy": "Ohodnotených všetkých {n} úryvkov. Skopírujte hlasy ako JSON a pošlite ich Claudovi.",
        "help": "Medzerník prehrať/pauza · 1 2 3 hlasovať · ← → predchádzajúci/ďalší úryvok · kliknutím na riadok sa presuniete na jeho čas",
    },
    "cs": {
        "title": "Slepý test titulků", "window": "Úryvek",
        "sub": "Každý úryvek přehraje několik sekund zvuku se dvěma verzemi titulků, A a B, v náhodném pořadí. Poslouchejte, čtěte a vyberte tu, kterou byste raději zveřejnili. Slova, která se liší, jsou zvýrazněná.",
        "marks": "Zvýraznit rozdíly", "aBetter": "A je lepší", "same": "Zhruba stejné", "bBetter": "B je lepší",
        "notePh": "Volitelně: co rozhodlo (špatné slovo, chybějící řeč, příliš rychlý titulek…)",
        "copy": "Kopírovat hlasy jako JSON", "next": "Další úryvek →", "copied": "Zkopírováno",
        "ready": "Připraveno", "saving": "Ukládám…", "saved": "Uloženo",
        "saveFailed": "Nepodařilo se uložit. Zkuste hlasovat znovu.",
        "notSaved": "Neuloženo: hlasy se ukládají jen při otevření v claude.ai. Použijte „Kopírovat hlasy jako JSON“.",
        "lost": "Spojení s uloženými hlasy se ztratilo. Načtěte stránku znovu.",
        "doneSaved": "Ohodnoceno všech {n} úryvků. Odpovědi jsou uložené; řekněte Claudovi, že jste hotový.",
        "doneCopy": "Ohodnoceno všech {n} úryvků. Zkopírujte hlasy jako JSON a pošlete je Claudovi.",
        "help": "Mezerník přehrát/pauza · 1 2 3 hlasovat · ← → předchozí/další úryvek · kliknutím na řádek se přesunete na jeho čas",
    },
}


# ---------------------------------------------------------------------------------------------- SRT and spans

def norm(w):
    """Word key: NFC, lower case, punctuation dropped, diacritics kept (byt and byť are different words in sk/cs;
    this deliberately differs from listen.py, which folds accents). A punctuation-only token has an empty key."""
    return "".join(c for c in unicodedata.normalize("NFC", w).lower()
                   if c.isalnum() or unicodedata.category(c).startswith("M"))


def parse_srt(text):
    """[(start, end, text)] in seconds; the cue text joins its lines."""
    out = []
    for block in text.replace("\r", "").lstrip("\ufeff").strip().split("\n\n"):
        lines = block.split("\n")
        m = re.findall(r"(\d+):(\d+):(\d+)[,.](\d+)", lines[1] if len(lines) > 1 else "")
        if len(m) != 2:
            continue
        t = [int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000 for h, mi, s, ms in m]
        out.append((t[0], t[1], " ".join(lines[2:]).strip()))
    return out


def read_srt(path):
    with open(path, encoding="utf-8-sig") as f:
        return parse_srt(f.read())


def cue_words(cues):
    """(word, cue start, cue end) for every word that has a letter or digit."""
    return [(w, c[0], c[1]) for c in cues for w in c[2].split() if norm(w)]


def spans(a_words, b_words):
    """Spans where the two word lists differ (normalised, diacritics kept), as listen.py does it: differences up to MERGE_GAP words
    apart are merged. Each span: {t0, t1, a, b} with the differing words (a / b) and the time range both sides cover."""
    ka, kb = [norm(w[0]) for w in a_words], [norm(w[0]) for w in b_words]
    ops = [o for o in difflib.SequenceMatcher(None, ka, kb, autojunk=False).get_opcodes() if o[0] != "equal"]
    merged = []
    for o in ops:
        if merged and o[1] - merged[-1][2] <= MERGE_GAP and o[3] - merged[-1][4] <= MERGE_GAP:
            merged[-1] = ("replace", merged[-1][1], o[2], merged[-1][3], o[4])
        else:
            merged.append(o)
    out = []
    for _, i1, i2, j1, j2 in merged:
        ci1, ci2 = max(0, i1 - CONTEXT), min(len(a_words), i2 + CONTEXT)
        cj1, cj2 = max(0, j1 - CONTEXT), min(len(b_words), j2 + CONTEXT)
        ts = [t for w in a_words[ci1:ci2] for t in (w[1], w[2])] + [t for w in b_words[cj1:cj2] for t in (w[1], w[2])]
        if not ts:
            continue
        out.append({"t0": round(max(0.0, min(ts) - 0.5), 2), "t1": round(max(ts) + 0.7, 2),
                    "a": " ".join(w[0] for w in a_words[i1:i2]), "b": " ".join(w[0] for w in b_words[j1:j2])})
    return out


# ---------------------------------------------------------------------------------------------- window picking

def window_text(cues, t0, t1):
    return " ".join(norm(w) for c in cues if c[1] > t0 and c[0] < t1 for w in c[2].split() if norm(w))


def window_for(span, seconds, rng, limit):
    """Window start for a span: the span's centre sits somewhere in the middle half of the window, so it is not always
    in the same spot; clamped to [0, limit - seconds]."""
    centre = (span["t0"] + span["t1"]) / 2
    start = centre - seconds * rng.uniform(0.25, 0.75)
    return round(max(0.0, min(start, max(0.0, limit - seconds))), 2)


def load_contested(path):
    """{item: [{t0, t1}]} from a T3 judge export. Accepts {item: [spans]}, a list of spans carrying an `item` key,
    or a flat list. A span with a `verdict` is kept only when it is worse / both wrong."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    flat = []
    if isinstance(data, dict):
        for item, lst in data.items():
            if isinstance(lst, list):
                flat += [dict(s, item=s.get("item", item)) for s in lst if isinstance(s, dict)]
    elif isinstance(data, list):
        flat = [s for s in data if isinstance(s, dict)]
    out = {}
    for s in flat:
        v = str(s.get("verdict", "worse")).strip().lower()
        if v not in BAD_VERDICTS or "item" not in s or "t0" not in s or "t1" not in s:
            continue
        out.setdefault(s["item"], []).append({"t0": float(s["t0"]), "t1": float(s["t1"])})
    return out


def pick_windows(per_item, seconds, total, rng, contested=None):
    """per_item: {item: {"spans": [...], "limit": seconds, "a": cues, "b": cues}}.
    Returns [{item, t0, source}] (t0 = window start, sorted by item then time). Half from `contested` spans when given
    (as many as exist), the rest from random differing spans; windows of one item never overlap and always hold
    differing text. Fewer windows than asked are returned when the versions do not differ enough."""
    items = sorted(per_item)
    picked = {i: [] for i in items}

    def free(item, s):
        return all(abs(s - p["t0"]) >= seconds + PRE for p in picked[item])

    def differs(item, s):
        d = per_item[item]
        return window_text(d["a"], s, s + seconds) != window_text(d["b"], s, s + seconds)

    def shuffled(spans_):
        """Each span can be tried a few times: a different window offset may fit where the first one overlapped."""
        pool = list(spans_) * RETRIES
        rng.shuffle(pool)
        return pool

    def take(pools, want, source):
        """Round-robin over items so every item gets windows; each pool is a shuffled list of spans."""
        got = 0
        while got < want and any(pools.values()):
            for item in items:
                pool = pools.get(item) or []
                while pool and got < want:
                    span = pool.pop()
                    s = window_for(span, seconds, rng, per_item[item]["limit"])
                    if free(item, s) and differs(item, s):
                        picked[item].append({"item": item, "t0": s, "source": source})
                        got += 1
                        break
                if got >= want:
                    break
        return got

    n_contested = 0
    if contested:
        pools = {i: shuffled(contested.get(i, [])) for i in items}
        n_contested = take(pools, total // 2, "contested")
    pools = {i: shuffled(per_item[i]["spans"]) for i in items}
    take(pools, total - n_contested, "random")
    out = [w for i in items for w in sorted(picked[i], key=lambda w: w["t0"])]
    return out


# ---------------------------------------------------------------------------------------------- build

def cut_mp3(wav, t0, dur):
    """MP3 bytes (32 kbps mono) of wav[t0, t0+dur]."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t0):.2f}", "-t", f"{dur:.2f}", "-i", wav,
                        "-ac", "1", "-ar", "22050", "-b:a", "32k", "-f", "mp3", "-"], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise SystemExit(f"ffmpeg failed for {wav} @ {t0}: {r.stderr.decode(errors='replace')[-300:]}")
    return r.stdout


def clip_cues(cues, a0, a1):
    """Cues overlapping [a0, a1], times relative to a0 and clipped to the window."""
    return [[round(max(c[0], a0) - a0, 2), round(min(c[1], a1) - a0, 2), c[2]] for c in cues if c[1] > a0 and c[0] < a1 and c[2]]


def load_manifest(path):
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    items = m["items"] if isinstance(m, dict) else m
    return {it["id"]: it for it in items}


def srt_path(runs, version, item, lang):
    return os.path.join(runs, version, item, f"captions_{lang}.srt")


def js(obj):
    """JSON for inlining in a <script>: no closing tag can appear, U+2028/9 escaped."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029").replace("<!--", "<\\!--")


def render_page(template, items, audio, labels):
    for token in ("/*ITEMS*/[]", "/*AUDIO*/{}", "/*LABELS*/{}"):
        if template.count(token) != 1:
            raise SystemExit(f"template placeholder {token} missing or repeated")
    # function replacement: no backslash processing of the data
    out = template.replace("/*ITEMS*/[]", js(items)).replace("/*AUDIO*/{}", js(audio)).replace("/*LABELS*/{}", js(labels))
    return out


def build(args):
    manifest = load_manifest(os.path.expanduser(args.manifest))
    runs = os.path.expanduser(args.runs)
    rng = random.Random(args.seed)
    contested = load_contested(args.contested) if args.contested else None
    per_item = {}
    for item in args.items:
        if item not in manifest:
            raise SystemExit(f"{item}: not in the manifest")
        it = manifest[item]
        lang = it["language"]
        if lang not in LABELS:
            raise SystemExit(f"{item}: language {lang!r} has no labels (sk, cs)")
        wav = (it.get("paths") or {}).get("audioWav") or os.path.join(os.path.dirname(os.path.expanduser(args.manifest)), item, "audio.wav")
        if not os.path.exists(wav):
            raise SystemExit(f"{item}: {wav} missing")
        sides = {}
        for v in (args.version_a, args.version_b):
            p = srt_path(runs, v, item, lang)
            if not os.path.exists(p):
                raise SystemExit(f"{item}: {p} missing")
            sides[v] = read_srt(p)
        a, b = sides[args.version_a], sides[args.version_b]
        per_item[item] = {"lang": lang, "wav": wav, "a": a, "b": b,
                          "spans": spans(cue_words(a), cue_words(b)),
                          "limit": float(it.get("audioWavSeconds") or max([c[1] for c in a + b] or [0.0]))}
        print(f"{item} ({lang}): {len(per_item[item]['spans'])} differing spans", file=sys.stderr)
    windows = pick_windows(per_item, args.seconds, args.windows, rng, contested)
    if len(windows) < args.windows:
        print(f"warning: only {len(windows)} of {args.windows} windows found (the versions differ too little)", file=sys.stderr)
    if not windows:
        raise SystemExit("no differing windows: nothing to test")
    rng.shuffle(windows)
    # votes of an older build in the same artifact database must never be read through this build's key
    build_id = hashlib.sha1(f"{args.version_a}|{args.version_b}|{args.seed}|{args.windows}|{args.seconds}|{os.urandom(4).hex()}".encode()).hexdigest()[:6]

    items, audio, key = [], {}, {}
    for w in windows:
        d = per_item[w["item"]]
        a0 = max(0.0, w["t0"] - PRE)
        a1 = w["t0"] + args.seconds
        wid = f"{w['item']}-{int(w['t0'])}-{build_id}"
        a_first = rng.random() < 0.5
        va, vb = (args.version_a, args.version_b) if a_first else (args.version_b, args.version_a)
        by = {args.version_a: d["a"], args.version_b: d["b"]}
        items.append({"id": wid, "item": w["item"], "lang": d["lang"], "at": round(a0, 2), "dur": round(a1 - a0, 2),
                      "A": clip_cues(by[va], a0, a1), "B": clip_cues(by[vb], a0, a1)})
        audio[wid] = "data:audio/mpeg;base64," + base64.b64encode(cut_mp3(d["wav"], a0, a1 - a0)).decode()
        key[wid] = {"A": va, "B": vb, "item": w["item"], "lang": d["lang"], "t0": round(a0, 2), "t1": round(a1, 2), "source": w["source"]}

    with open(os.path.join(HERE, "abtest-template.html"), encoding="utf-8") as f:
        template = f.read()
    langs = sorted({i["lang"] for i in items})
    page = render_page(template, items, audio, {l: LABELS[l] for l in langs})
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "abtest.html"), "w", encoding="utf-8") as f:
        f.write(page)
    with open(os.path.join(args.out, "key.json"), "w", encoding="utf-8") as f:
        json.dump({"versionA": args.version_a, "versionB": args.version_b, "seed": args.seed, "build": build_id, "windows": key}, f, ensure_ascii=False, indent=1)
    n_c = sum(1 for w in key.values() if w["source"] == "contested")
    print(f"{len(items)} windows ({n_c} contested, {len(items) - n_c} random), {len(page) / 1e6:.2f} MB -> {args.out}/abtest.html; key -> {args.out}/key.json")
    if len(page) > 16 * 1024 * 1024:
        print("warning: the page is over 16 MB; the artifact size limit will refuse it. Use fewer or shorter windows.", file=sys.stderr)


# ---------------------------------------------------------------------------------------------- unblind

def wilson(k, n, z=1.959964):
    """95 % Wilson score interval for k successes in n trials; (0, 1) when n = 0."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def tally(key, votes):
    """Resolve votes through the key. Returns (wins {version: n}, same n, rows). Windows without a vote are skipped;
    a vote for a window missing from the key is an error."""
    wins = {key["versionA"]: 0, key["versionB"]: 0}
    same, rows = 0, []
    for wid, v in sorted(votes.items()):
        if wid not in key["windows"]:
            print(f"warning: vote for {wid} is not in this key (an older build?), skipped", file=sys.stderr)
            continue
        w = key["windows"][wid]
        choice = (v or {}).get("choice")
        if choice not in ("A", "B", "same"):
            continue
        winner = w[choice] if choice in ("A", "B") else "same"
        if winner == "same":
            same += 1
        else:
            wins[winner] += 1
        rows.append({"id": wid, "item": w["item"], "source": w["source"], "winner": winner, "note": (v or {}).get("note", "")})
    return wins, same, rows


def load_votes(path):
    """{window id: {choice, note}}. Accepts that object, a {"votes": {...}} wrapper, ids prefixed "votes/", and lists of
    {id, choice, note} or {id, data: {choice, note}} (a collection export). A vote without a valid choice is an error."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and isinstance(data.get("votes"), (dict, list)):
        data = data["votes"]
    if isinstance(data, list):
        pairs = []
        for d in data:
            if not isinstance(d, dict) or "id" not in d:
                raise SystemExit(f"vote entry without an id: {d!r}")
            pairs.append((d["id"], d["data"] if isinstance(d.get("data"), dict) else d))
    elif isinstance(data, dict):
        pairs = list(data.items())
    else:
        raise SystemExit("votes file: expected an object or a list")
    out = {}
    for wid, v in pairs:
        wid = str(wid).split("/")[-1]
        if not isinstance(v, dict) or v.get("choice") not in ("A", "B", "same"):
            raise SystemExit(f"vote {wid}: no valid choice (A, B or same): {v!r}")
        out[wid] = v
    return out


def pct(x):
    return f"{100 * x:.0f}%"


def unblind(args):
    with open(os.path.join(args.out_dir, "key.json"), encoding="utf-8") as f:
        key = json.load(f)
    wins, same, rows = tally(key, load_votes(args.votes))
    va, vb = key["versionA"], key["versionB"]
    total = len(rows)
    n = wins[va] + wins[vb]
    print(f"{total} of {len(key['windows'])} windows voted; {n} decided, {same} 'same'\n")
    print(f"{'version':24} {'wins':>5} {'share of decided':>17}   95% Wilson interval")
    for v in (va, vb):
        lo, hi = wilson(wins[v], n)
        print(f"{v:24} {wins[v]:>5} {pct(wins[v] / n) if n else '-':>17}   {pct(lo)} - {pct(hi)}")
    lo, hi = wilson(wins[vb], n)
    if n == 0:
        reading = "no decided votes"
    elif hi < 0.5:
        reading = f"{vb} is clearly worse than {va} (the interval is entirely below 50%)"
    elif lo > 0.5:
        reading = f"{vb} is clearly better than {va} (the interval is entirely above 50%)"
    else:
        reading = f"{vb} is not clearly worse (the interval includes 50%): no veto"
    print(f"\nReading ({vb} as the candidate): {reading}")
    for src in ("contested", "random"):
        sub = [r for r in rows if r["source"] == src]
        if sub:
            c = {va: 0, vb: 0, "same": 0}
            for r in sub:
                c[r["winner"]] += 1
            print(f"  {src:9} windows: {va} {c[va]} / {vb} {c[vb]} / same {c['same']}")
    print("\nPer window:")
    for r in rows:
        note = f"  - {r['note']}" if r["note"] else ""
        print(f"  {r['id']:28} {r['source']:9} {r['winner']}{note}")


# ---------------------------------------------------------------------------------------------- cli

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build the blind test page and the answer key")
    b.add_argument("version_a")
    b.add_argument("version_b")
    b.add_argument("items", nargs="+", help="corpus item ids")
    b.add_argument("--windows", type=int, default=20)
    b.add_argument("--seconds", type=float, default=25.0)
    b.add_argument("--contested", help="JSON of judge spans (worse / both wrong) with item, t0, t1")
    b.add_argument("--out", default=os.path.join(CORPUS, "abtest"), help="output folder (default ~/LuskCorpus/abtest, outside the repo: it holds the answer key)")
    b.add_argument("--manifest", default=os.path.join(CORPUS, "manifest.json"))
    b.add_argument("--runs", default=os.path.join(CORPUS, "runs"), help="folder holding <version>/<item>/captions_<lang>.srt")
    b.add_argument("--seed", type=int, default=20261027)
    u = sub.add_parser("unblind", help="tally a votes file against the answer key")
    u.add_argument("out_dir")
    u.add_argument("votes")
    args = p.parse_args(argv)
    if args.cmd == "build":
        if args.version_a == args.version_b:
            p.error("the two versions must differ")
        build(args)
    else:
        unblind(args)


if __name__ == "__main__":
    main()

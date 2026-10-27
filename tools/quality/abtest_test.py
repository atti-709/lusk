#!/usr/bin/env python3
"""Checks for abtest.py: python3 -I tools/quality/abtest_test.py (needs ffmpeg for the build test)."""
import json
import os
import random
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abtest as ab  # noqa: E402


def srt(cues):
    def ts(t):
        return f"{int(t // 3600):02}:{int(t // 60) % 60:02}:{int(t % 60):02},{int(round((t % 1) * 1000)):03}"
    return "\n".join(f"{i + 1}\n{ts(a)} --> {ts(b)}\n{t}\n" for i, (a, b, t) in enumerate(cues))


def test_spans():
    a = ab.cue_words([(0, 2, "Dobrý deň, vážení."), (2, 4, "Dnes budeme hovoriť o láske.")])
    same_but_punct = ab.cue_words([(0, 2, "dobrý deň vážení"), (2, 4, "Dnes budeme hovoriť, o láske!")])
    assert ab.spans(a, same_but_punct) == [], "punctuation and case are not differences"
    decomposed = ab.cue_words([(0, 2, "Dobry\u0301 den\u030c, va\u0301z\u030cení.")])
    assert ab.spans(ab.cue_words([(0, 2, "Dobrý deň, vážení.")]), decomposed) == [], "NFC vs NFD is not a difference"
    accent = ab.spans(ab.cue_words([(0, 2, "to musí byť pravda")]), ab.cue_words([(0, 2, "to musí byt pravda")]))
    assert len(accent) == 1 and accent[0]["a"] == "byť" and accent[0]["b"] == "byt", "an accent-only difference is a span"
    assert ab.window_text([(0, 2, "byť")], 0, 2) != ab.window_text([(0, 2, "byt")], 0, 2), "and a window differs"
    b = ab.cue_words([(0, 2, "Dobrý deň, vážení."), (2, 4, "Dnes budeme hovoriť o láskavosti.")])
    s = ab.spans(a, b)
    assert len(s) == 1 and s[0]["a"] == "láske." and s[0]["b"] == "láskavosti.", s
    assert s[0]["t0"] <= 2 and s[0]["t1"] >= 4
    # two edits three words apart merge into one span, far apart stay two
    words = lambda t: ab.cue_words([(0, 10, t)])
    base = "a1 b2 c3 d4 e5 f6 g7 h8 i9 j10 k11 l12 m13 n14 o15 p16 q17 r18"
    near = base.replace("c3", "X").replace("f6", "Y")
    far = base.replace("a1", "X").replace("r18", "Y")
    assert len(ab.spans(words(base), words(near))) == 1
    assert len(ab.spans(words(base), words(far))) == 2
    # a dropped word is a span with an empty side
    d = ab.spans(words(base), words(base.replace(" e5", "")))
    assert len(d) == 1 and d[0]["a"] == "e5" and d[0]["b"] == "", d


def synthetic(n_cues=400):
    """A transcript of 400 five-second cues and a copy with ~30 words altered."""
    a, b = [], []
    changed = random.Random(7).sample(range(0, n_cues, 3), 30)
    for i in range(n_cues):
        text = f"slovo{i} druhe{i} tretie{i} stvrte{i}"
        a.append((i * 5.0, i * 5.0 + 4.5, text))
        b.append((i * 5.0, i * 5.0 + 4.5, text.replace(f"tretie{i}", f"zmena{i}") if i in changed else text))
    return a, b, sorted(changed)


def test_pick_windows():
    a, b, changed = synthetic()
    d = {"x": {"spans": ab.spans(ab.cue_words(a), ab.cue_words(b)), "limit": 2000.0, "a": a, "b": b}}
    assert len(d["x"]["spans"]) == 30
    w = ab.pick_windows(d, 25.0, 20, random.Random(1))
    assert len(w) == 20 and all(x["source"] == "random" for x in w)
    starts = sorted(x["t0"] for x in w)
    assert all(q - p >= 25.0 for p, q in zip(starts, starts[1:])), "windows never overlap"
    assert all(ab.window_text(a, x["t0"], x["t0"] + 25) != ab.window_text(b, x["t0"], x["t0"] + 25) for x in w)
    assert w == ab.pick_windows(d, 25.0, 20, random.Random(1)), "seeded"
    assert w != ab.pick_windows(d, 25.0, 20, random.Random(2))
    # half from contested spans: 10 contested spots first, the rest random
    contested = {"x": [{"t0": i * 5.0, "t1": i * 5.0 + 4.5} for i in changed[:15]]}
    w = ab.pick_windows(d, 25.0, 20, random.Random(3), contested)
    assert sum(x["source"] == "contested" for x in w) == 10 and len(w) == 20, [x["source"] for x in w]
    near = lambda x: any(abs((x["t0"] + 12.5) - (c["t0"] + c["t1"]) / 2) <= 12.5 + 1 for c in contested["x"])
    assert all(near(x) for x in w if x["source"] == "contested")
    # fewer contested spans than half: they all go in, the rest is random
    w = ab.pick_windows(d, 25.0, 20, random.Random(3), {"x": [{"t0": i * 5.0, "t1": i * 5.0 + 4.5} for i in (changed[0], changed[10], changed[20])]})
    assert sum(x["source"] == "contested" for x in w) == 3 and len(w) == 20
    # identical versions: nothing to test
    assert ab.pick_windows({"x": {"spans": [], "limit": 100.0, "a": a, "b": a}}, 25.0, 20, random.Random(1)) == []


def test_contested_loader():
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, "c.json")
        json.dump({"E1": [{"t0": 1, "t1": 5, "verdict": "worse"}, {"t0": 9, "t1": 12, "verdict": "better"},
                          {"t0": 20, "t1": 24, "verdict": "both wrong"}]}, open(p, "w"))
        assert ab.load_contested(p) == {"E1": [{"t0": 1.0, "t1": 5.0}, {"t0": 20.0, "t1": 24.0}]}
        json.dump([{"item": "E2", "t0": 3, "t1": 4}], open(p, "w"))
        assert ab.load_contested(p) == {"E2": [{"t0": 3.0, "t1": 4.0}]}


def test_wilson():
    lo, hi = ab.wilson(14, 20)
    assert abs(lo - 0.4810) < 1e-3 and abs(hi - 0.8545) < 1e-3, (lo, hi)  # reference values for 14 of 20
    assert ab.wilson(0, 0) == (0.0, 1.0)
    lo, hi = ab.wilson(0, 10)
    assert abs(lo) < 1e-9 and 0.25 < hi < 0.30
    lo, hi = ab.wilson(10, 10)
    assert abs(hi - 1.0) < 1e-9 and 0.70 < lo < 0.75
    lo, hi = ab.wilson(50, 100)
    assert abs((lo + hi) / 2 - 0.5) < 1e-9 and 0.40 < lo < 0.41


def test_tally():
    key = {"versionA": "01-v0", "versionB": "02-x", "windows": {
        "w1": {"A": "01-v0", "B": "02-x", "item": "i", "source": "random"},
        "w2": {"A": "02-x", "B": "01-v0", "item": "i", "source": "contested"},
        "w3": {"A": "02-x", "B": "01-v0", "item": "i", "source": "contested"}}}
    wins, same, rows = ab.tally(key, {"w1": {"choice": "B"}, "w2": {"choice": "A"}, "w3": {"choice": "same"}})
    assert wins == {"01-v0": 0, "02-x": 2} and same == 1 and len(rows) == 3


def test_load_votes():
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, "v.json")
        want = {"w1": {"choice": "A", "note": "n"}}
        for shape in (want, {"votes": want}, {"votes/w1": want["w1"]},
                      [{"id": "w1", "choice": "A", "note": "n"}], [{"id": "w1", "data": want["w1"]}]):
            json.dump(shape, open(p, "w"))
            assert ab.load_votes(p) == {"w1": {"choice": "A", "note": "n"}} or ab.load_votes(p)["w1"]["choice"] == "A", shape
        for bad in ({"w1": {"choice": None}}, [{"choice": "A"}], {"w1": "A"}):
            json.dump(bad, open(p, "w"))
            try:
                ab.load_votes(p)
            except SystemExit:
                continue
            raise AssertionError(f"accepted {bad}")


def test_window_gap():
    a, b, _ = synthetic()
    d = {"x": {"spans": ab.spans(ab.cue_words(a), ab.cue_words(b)), "limit": 2000.0, "a": a, "b": b}}
    s = sorted(x["t0"] for x in ab.pick_windows(d, 25.0, 20, random.Random(4)))
    assert all(q - p >= 25.0 + ab.PRE for p, q in zip(s, s[1:])), "clips (with their lead-in) never overlap"


def test_build_and_unblind():
    a, b, changed = synthetic()
    with tempfile.TemporaryDirectory() as t:
        wav = os.path.join(t, "corpus", "x1", "audio.wav")
        os.makedirs(os.path.dirname(wav))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=2100", "-ac", "1", "-ar", "16000", wav], check=True)
        manifest = os.path.join(t, "corpus", "manifest.json")
        json.dump({"items": [{"id": "x1", "language": "cs", "paths": {"audioWav": wav}}]}, open(manifest, "w"))
        runs = os.path.join(t, "runs")
        for v, cues in (("v0", a), ("v1", b)):
            os.makedirs(os.path.join(runs, v, "x1"))
            open(os.path.join(runs, v, "x1", "captions_cs.srt"), "w", encoding="utf-8").write(srt(cues))
        out = os.path.join(t, "out")
        contested = os.path.join(t, "c.json")
        json.dump({"x1": [{"t0": i * 5.0, "t1": i * 5.0 + 4.5, "verdict": "worse"} for i in changed]}, open(contested, "w"))
        ab.main(["build", "v0", "v1", "x1", "--manifest", manifest, "--runs", runs, "--out", out, "--contested", contested])
        page = open(os.path.join(out, "abtest.html"), encoding="utf-8").read()
        assert len(page) < 16 * 1024 * 1024
        assert page.count("/*ITEMS*/[]") == 0 and "data:audio/mpeg;base64," in page
        key = json.load(open(os.path.join(out, "key.json")))
        assert len(key["windows"]) == 20
        assert sum(w["source"] == "contested" for w in key["windows"].values()) == 10
        assert {w["A"] for w in key["windows"].values()} == {"v0", "v1"}, "sides are shuffled"
        for w in key["windows"].values():
            assert {w["A"], w["B"]} == {"v0", "v1"}
        # the page data holds the ids but neither version name
        m = re.search(r"const ITEMS = (.*?);\nconst AUDIO", page, re.S)
        items = json.loads(m.group(1).replace("<\\/", "</"))
        assert len(items) == 20 and all(i["lang"] == "cs" for i in items)
        assert '"v1"' not in m.group(1) and '"v0"' not in m.group(1)
        # well-formed: one script block, balanced html tags in the markup part
        assert page.count("<script>") == 1 and page.count("</script>") == 1
        markup = re.sub(r"(?s)<script>.*?</script>|<style>.*?</style>", "", page)
        for tag in ("div", "section", "header", "nav", "button", "span", "label", "p", "h1", "body", "html", "head"):
            assert len(re.findall(rf"<{tag}[\s>]", markup)) == len(re.findall(rf"</{tag}>", markup)), tag
        # votes: always pick version v1 (a window's side B or A depending on the shuffle)
        votes = {wid: {"choice": "A" if w["A"] == "v1" else "B", "note": ""} for wid, w in key["windows"].items()}
        first = sorted(votes)[0]
        votes[first] = {"choice": "same", "note": "tie"}
        p = os.path.join(t, "votes.json")
        json.dump(votes, open(p, "w"))
        wins, same, rows = ab.tally(key, ab.load_votes(p))
        assert wins == {"v0": 0, "v1": 19} and same == 1
        ab.main(["unblind", out, p])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")

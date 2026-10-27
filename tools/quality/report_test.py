#!/usr/bin/env python3
"""Checks for report.py: python3 -I tools/quality/report_test.py (no network, no Gemini; ffmpeg is not needed)."""
import io
import json
import os
import sys
import tempfile
import urllib.error

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report as rp  # noqa: E402


def W(text, t0=0.0, step=0.5):
    return rp.cue_words([(t0 + i * step, t0 + (i + 1) * step, w) for i, w in enumerate(text.split())])


def test_spans_diacritics():
    a = W("to musí byť pravda")
    assert rp.spans(a, W("to musí byt pravda"))[0]["old_diff"] == "byť", "accent-only difference is a span"
    assert rp.spans(a, W("To musí, BYŤ pravda!")) == [], "case and punctuation are not"
    assert rp.spans(W("Dobrý deň"), W("Dobrý deň")) == [], "NFC vs NFD"
    s = rp.spans(W("a b c d e f g h i j k l m n o p"), W("a b c d e f g h X j k l m n o p"))
    assert len(s) == 1 and s[0]["old_diff"] == "i" and s[0]["new_diff"] == "X" and s[0]["dt"] == 4.0, s
    d = rp.spans(W("a b c d e"), W("a b d e"))
    assert d[0]["old_diff"] == "c" and d[0]["new_diff"] == "", "a dropped word has an empty side"
    # a long span is cut around the first differing word, never over 25 s
    long = {"t0": 0, "t1": 60, "dt": 30}
    assert rp.snippet_range(long) == (26, 40)
    assert rp.snippet_range({"t0": 5, "t1": 12, "dt": 6}) == (5, 12)


def test_tag_stripping():
    assert rp.strip_tags("[hudba]") == ""
    assert rp.strip_tags(">> Dobrý [potlesk] deň") == "Dobrý deň"
    assert rp.strip_tags(">>Dobrý") == "Dobrý"
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, "yt.srt")
        open(p, "w").write("1\n00:00:00,000 --> 00:00:04,000\n[hudba]\n\n2\n00:00:05,000 --> 00:00:06,000\n[potlesk]\n\n"
                           "3\n00:00:07,000 --> 00:00:09,000\n>> Dobrý deň [hudba]\n\n")
        cues, masks = rp.youtube_cues(p)
        assert cues == [(7.0, 9.0, "Dobrý deň")], cues
        assert [(m["kind"], m["t0"]) for m in masks] == [("music", 0.0), ("sound", 5.0)], masks
        # tags and markers are not differences
        assert rp.spans(rp.cue_words(cues), W("dobrý deň", 7.0)) == []


def test_fillers():
    a = rp.cue_words([(0, 4, "zřídka ale jsou eh to lidé e, kteří")])
    assert [w[0] for w in a] == ["zřídka", "ale", "jsou", "to", "lidé", "kteří"]
    assert rp.spans(a, rp.cue_words([(0, 4, "zřídka, ale jsou to lidé kteří")])) == [], "a filler is no difference"
    assert [w[0] for w in rp.cue_words([(0, 1, "A ehm Eh")])] == ["A"]


def test_review_fixes():
    # an unanswered audit window is not counted as all right
    wins = [{"marks": [{"word": "x", "ok": True}] * 5, "missed": [], "answered": False}, {"marks": [{"word": "y", "ok": False, "type": "name"}], "missed": [], "answered": True}]
    s = rp.summarize_audit(wins)
    assert s["words"] == 1 and s["rate"] == 1.0 and s["unanswered"] == 1
    # an answer that lacks items twice is a failure, not an empty result
    calls = []
    orig = rp.call_gemini
    rp.call_gemini = lambda parts, key, **kw: calls.append(1) or [{"id": 0}]
    try:
        rp.ask([], "k", 2)
        raise AssertionError("should have failed")
    except rp.ApiFailure:
        assert len(calls) == 2
    finally:
        rp.call_gemini = orig
    # a run version without meta.json is refused (YouTube has none by nature)
    assert "no meta.json" in rp.guard(meta(), None, run_vs=True) and rp.guard(meta(), None) is None
    # masks keep their real length from json3
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, "y.json3")
        json.dump({"events": [{"tStartMs": 1000, "dDurationMs": 30000, "segs": [{"utf8": "[hudba]"}]},
                              {"tStartMs": 40000, "dDurationMs": 4000, "segs": [{"utf8": "slovo"}, {"utf8": " [potlesk]", "tOffsetMs": 2000}]}]}, open(p, "w"))
        m = rp.json3_masks(p)
        assert [(x["kind"], x["t0"], x["t1"]) for x in m] == [("music", 1.0, 31.0), ("sound", 42.0, 44.0)], m
    # cue-start lag against the VAD turn
    cues = [(5.2, 6.0, "ahoj"), (6.1, 7.0, "svet"), (12.5, 13.0, "dnes")]
    assert [round(x[0], 2) for x in rp.vad_cue_lags(cues, [(5.0, 7.0), (12.0, 13.0)])] == [0.2, 0.5]


def test_audit_windows():
    a = rp.audit_windows("itemX", 1500.0)
    assert len(a) == 30 and a == sorted(set(a)) and all(t % 8 == 0 and t + 8 <= 1500 for t in a)
    assert a == rp.audit_windows("itemX", 1500.0), "seeded by the item id: the same for every version"
    assert a != rp.audit_windows("itemY", 1500.0)
    assert len(rp.audit_windows("short", 40.0)) == 5 and rp.audit_windows("tiny", 3.0) == []
    words = [("a", 7.8, 8.2), ("b", 8.5, 9.0), ("c", 15.9, 16.3)]
    assert [w[0] for w in rp.window_words(words, 8.0)] == ["a", "b"], "a word belongs to the window holding its middle"
    wins = [{"marks": [{"word": "x", "ok": True}, {"word": "y", "ok": False, "type": "ending"}], "missed": ["z"], "answered": True}]
    s = rp.summarize_audit(wins)
    assert s["words"] == 2 and s["wrong"] == 2 and s["byType"]["ending"] == 1 and s["byType"]["dropped word"] == 1 and abs(s["rate"] - 2 / 3) < 1e-9


def test_layout():
    cues = [(0, 8, "Toto je dlhý titulok, ktorý trvá\nviac ako sedem sekúnd a"),
            (8, 10, "pokračuje.\nA toto je veľmi dlhý riadok, ktorý má viac ako 42 znakov."),
            (10, 12, "Povedal to. potom odišiel"), (12, 14, "resp. to alebo tzv. ono. potom"),
            (14, 16, "Je to tak? ale nie vždy"), (16, 18, "Verš 3. dnes a čo ... ďalej."), (18, 19, "Bolo to 5. apríla.")]
    for lang in ("sk", "cs"):
        l = rp.layout(cues, lang)
        assert len(l["over7s"]) == 1 and l["over7s"][0]["t"] == 0.0
        assert len(l["longLines"]) == 1
        assert [x["text"] for x in l["oneLetterEnds"]] == ["viac ako sedem sekúnd a"], l["oneLetterEnds"]
        stops = [x["text"] for x in l["midSentenceStops"]]
        assert stops == ["to. potom", "ono. potom"], stops  # abbreviations, an ordinal and a capital are not stops
        assert len(l["questionLower"]) == 1 and "ale" in l["questionLower"][0]["text"]
    c, _ = rp.layout_counts(cues, "cs")
    assert c["cues"] == 7 and c["over7s"] == 1


def meta(**kw):
    m = {"completed": True, "passesOk": True, "settings": {"transcriptionLanguage": "cs"},
         "models": {"whisper": "large-v3-turbo", "whisperOverride": None, "geminiFlashLite": "L", "geminiReasoning": "R"},
         "passes": {"correction": "skipped", "proofread": {"status": "ok", "applied": 3}, "clips": {"status": "ok"}, "translation": {"status": "skipped"}, "failed": None}}
    for k, v in kw.items():
        m[k] = v
    return m


def test_pass_guard():
    a = meta()
    assert rp.guard(a, None) is None and rp.guard(a, meta()) is None
    assert "did not complete" in rp.guard(meta(passesOk=False), None), "YouTube only when the run's own passes are ok"
    assert "did not complete" in rp.guard(meta(completed=False), meta())
    assert "other version" in rp.guard(a, meta(passesOk=False))
    b = meta()
    b["passes"]["proofread"] = {"status": "failed"}
    assert "proofread: ok vs failed" in rp.guard(a, b)
    b = meta()
    b["models"]["geminiReasoning"] = "R2"
    assert "geminiReasoning: R vs R2" in rp.guard(a, b)
    b = meta()
    b["passes"]["proofread"] = {"status": "ok", "applied": 99}
    assert rp.guard(a, b) is None, "counts differ, the pass set does not"
    b = meta()
    b["models"]["whisper"] = "large-v3"
    assert rp.guard(a, b) is None and "ASR model differs" in rp.asr_note(a, b), "the Whisper model is the variable under test"
    assert "no meta.json" in rp.guard(None, None)


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def ok_answer(obj):
    return FakeResp(json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(obj)}]}}]}).encode())


def test_backoff():
    slept, now = [], [0.0]

    def sleep(s):
        slept.append(s)
        now[0] += s
    calls = []

    def opener(req, timeout=0):
        calls.append(1)
        if len(calls) <= 3:
            raise urllib.error.HTTPError("u", 429 if len(calls) < 3 else 503, "x", {}, None)
        return ok_answer([{"id": 0, "verdict": "A"}])
    r = rp.call_gemini([{"text": "x"}], "k", opener=opener, sleep=sleep, clock=lambda: now[0])
    assert r == [{"id": 0, "verdict": "A"}] and slept == [2.0, 4.0, 8.0], slept
    # keeps failing: ApiFailure after the budget, with doubling delays capped at 60 s
    slept.clear()
    now[0] = 0.0

    def always(req, timeout=0):
        raise urllib.error.HTTPError("u", 429, "x", {}, None)
    try:
        rp.call_gemini([{"text": "x"}], "k", opener=always, sleep=sleep, clock=lambda: now[0], total_s=300)
        raise AssertionError("should have failed")
    except rp.ApiFailure as e:
        assert "kept failing" in str(e)
    assert slept[:6] == [2.0, 4.0, 8.0, 16.0, 32.0, 60.0] and sum(slept) <= 300, slept
    # a 400 is not retried
    try:
        rp.call_gemini([{"text": "x"}], "k", opener=lambda r, timeout=0: (_ for _ in ()).throw(urllib.error.HTTPError("u", 400, "bad", {}, io.BytesIO(b"nope"))),
                       sleep=sleep, clock=lambda: now[0])
        raise AssertionError("should have failed")
    except rp.ApiFailure as e:
        assert "400" in str(e)


def test_checkpoint_resume():
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, "c.json")
        ck = rp.Checkpoint(p)
        ck.put("k1", {"answers": {"0": {"verdict": "A"}}}, 12.0)
        again = rp.Checkpoint(p)
        assert again.get("k1") == {"answers": {"0": {"verdict": "A"}}} and again.data["calls"] == 1 and again.session_calls == 0
        assert rp.batch_key("judge1", "x", [[1, 2, "a", "b"]]) == rp.batch_key("judge1", "x", [[1, 2, "a", "b"]])
        assert rp.batch_key("judge1", "x", [[1, 2, "a", "b"]]) != rp.batch_key("judge1", "x", [[1, 2, "a", "c"]])


def test_dropped_speech():
    words = [("a", 1.0, 1.5), ("b", 1.6, 2.0), ("c", 8.0, 8.5)]
    turns = [(1.0, 2.0), (3.0, 5.0), (7.9, 8.6), (10.0, 10.5)]
    h = rp.holes(turns, words)
    assert [(round(a, 1), round(b, 1)) for a, b in h] == [(3.0, 5.0)], h  # 0.5 s turn without words is under the minimum
    masks = [{"t0": 2.5, "t1": 3.5, "kind": "music"}]
    lost, masked = rp.split_masked(h, masks)
    assert abs(masked["music"] - 1.5) < 1e-9 and lost == [], (lost, masked)  # +-1 s padding masks 3.0-4.5; the 0.5 s rest is under the minimum
    d = rp.dropped_speech(turns, words, [{"t0": 0, "t1": 20, "kind": "music"}])
    assert d["lostSeconds"] == 0 and d["maskedMusicSeconds"] == 2.0
    d = rp.dropped_speech(turns, words, [])
    assert d["lostSeconds"] == 2.0 and d["maskedMusicSeconds"] == 0


def test_timing():
    words = [("a", 5.3, 5.6), ("b", 5.7, 6.0), ("c", 12.0, 12.4)]
    turns = [(5.0, 6.5), (6.6, 7.0), (11.5, 13.0), (20, 21)]
    lags = rp.vad_lags(words, turns)
    assert [round(x[0], 2) for x in lags] == [0.3, 0.5], lags  # 2nd turn follows within 0.4 s; 4th has no word
    st = rp.lag_stats([0.1, 0.2, 0.9, -0.8, 0.3])
    assert st["n"] == 5 and st["median"] == 0.2 and st["lateOver"] == 1 and st["earlyOver"] == 1
    ref = [(1.0, 1.3, "Ahoj"), (1.4, 1.7, "svet"), (1.8, 2.0, "dnes"), (2.1, 2.3, "je")]
    m = rp.match_lags([("ahoj", 1.5), ("svet", 1.9), ("dnes", 2.0), ("xx", 9.0)], ref)
    assert sorted(m) == [0, 1, 2] and abs(m[0] - 0.5) < 1e-9
    assert rp.match_lags([("ahoj", 1.5), ("svet", 1.9)], ref) == {}, "runs shorter than 3 words are not trusted"


def test_heavy_check_and_lock():
    ps = ["  101 /usr/bin/python3 /x/server/scripts/transcribe.py --audio a.wav", "  102 /x/claude --add-dir=/y/remotion-rendering",
          "  103 /x/track_speaker.py --x", "  104 /usr/bin/vim notes.txt", "  105 /a/node_modules/@remotion/compositor-darwin-arm64/remotion render"]
    got = rp.heavy_jobs_running(ps)
    assert [g.split()[0] for g in got] == ["101", "103", "105"], got
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, ".lock")
        rel = rp.acquire_lock(path=p)
        assert json.load(open(p))["pid"] == os.getpid()
        try:
            rp.acquire_lock(path=p)
            raise AssertionError("a held lock must refuse")
        except rp.LockHeld:
            pass
        rel()
        assert not os.path.exists(p)
        json.dump({"pid": 99999999, "startedAt": "x", "tool": "dead"}, open(p, "w"))
        rp.acquire_lock(path=p)()  # a dead holder's lock is stale and taken over


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")

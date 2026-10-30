#!/usr/bin/env python3
"""Build the T6 adjudication page: ~40 of the arbiter's decisions for the owner to judge by ear.

  python3 tools/quality/make_adjudication.py <version> [--n 40] [--seed 6] [--runs ~/LuskCorpus/runs] [--out ~/LuskCorpus/reports/t6-adjudication.html]

Reads <runs>/<version>/<item>/arbiter.json (written by `run.ts --arbiter`), samples judged spans (about 40 %
the arbiter gave to the base model, 40 % it left with the fine-tune, 20 % "same" / "neither", spread over the
items), and writes one self-contained HTML page (spans embedded, audio by relative path, so keep it in
~/LuskCorpus/reports/). The owner presses play, picks A / B / same / both wrong, and exports
~/Downloads/t6-adjudication.md; the arbiter's side is shown only after the owner's pick so it can't anchor it.
"""
import argparse, datetime, json, os, random, re

HOME = os.path.expanduser("~")
CORPUS = os.path.join(HOME, "LuskCorpus")
HERE = os.path.dirname(os.path.abspath(__file__))


def audio_rel(item, reports_dir):
    for p in (os.path.join(CORPUS, item, "audio.m4a"), os.path.join(CORPUS, item, "audio.wav"), os.path.join(HOME, "LuskBatch", "audio", item + ".wav")):
        if os.path.exists(p):
            return os.path.relpath(p, reports_dir)
    raise SystemExit(f"no audio for {item}")


def mark(context, core):
    """The context with the differing words wrapped in ** ** (the page bolds them)."""
    if core and core in context:
        return context.replace(core, f"**{core}**", 1)
    return context


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=6)
    ap.add_argument("--runs", default=os.path.join(CORPUS, "runs"))
    ap.add_argument("--out", default=os.path.join(CORPUS, "reports", "t6-adjudication.html"))
    args = ap.parse_args()
    out = os.path.expanduser(args.out)
    reports_dir = os.path.dirname(out)
    vdir = os.path.join(os.path.expanduser(args.runs), args.version)

    pool = {"base": [], "ft": [], "other": []}
    items = {}
    for item in sorted(os.listdir(vdir)):
        f = os.path.join(vdir, item, "arbiter.json")
        if item.startswith(".") or not os.path.exists(f):
            continue
        doc = json.load(open(f))
        items[item] = {"audio": audio_rel(item, reports_dir), "language": doc.get("language", "")}
        for sp in doc["spans"]:
            if sp.get("skipped") or not sp.get("judged"):
                continue
            v = sp.get("verdict")
            bucket = "base" if v == "base" else "ft" if v == "ft" else "other"
            pool[bucket].append((item, sp))
    rnd = random.Random(args.seed)
    want = {"base": round(args.n * 0.4), "ft": round(args.n * 0.4)}
    want["other"] = args.n - want["base"] - want["ft"]
    picked = []
    for bucket, k in want.items():
        rows = pool[bucket][:]
        rnd.shuffle(rows)
        # spread over the items: take round-robin by item
        by = {}
        for it, sp in rows:
            by.setdefault(it, []).append((it, sp))
        order = []
        while any(by.values()) and len(order) < k:
            for it in sorted(by):
                if by[it] and len(order) < k:
                    order.append(by[it].pop())
        picked += order
    rnd.shuffle(picked)
    spans = []
    for n, (item, sp) in enumerate(picked):
        ft_is_a = bool(sp.get("ftIsA"))
        a, b = ((sp["ftContext"], sp["baseContext"]) if ft_is_a else (sp["baseContext"], sp["ftContext"]))
        ca, cb = ((sp["ft"], sp["base"]) if ft_is_a else (sp["base"], sp["ft"]))
        spans.append({
            "id": f"{item}:{sp['id']}", "n": n + 1, "item": item, "t0": sp["t0"], "t1": sp["t1"],
            "A": mark(a, ca), "B": mark(b, cb), "ftIsA": ft_is_a, "verdict": sp["verdict"],
            "said": sp.get("said", ""), "ft": sp["ft"], "base": sp["base"],
        })
    counts = {k: len(v) for k, v in pool.items()}
    data = {"generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), "version": args.version, "items": items,
            "spans": spans, "poolSizes": counts}
    html = open(os.path.join(HERE, "adjudication_template.html")).read().replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
    os.makedirs(reports_dir, exist_ok=True)
    open(out, "w").write(html)
    print(out, len(spans), "spans from", len(items), "items; judged pool", counts)


if __name__ == "__main__":
    main()

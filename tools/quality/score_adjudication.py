#!/usr/bin/env python3
"""Score arbiter verdicts against the owner's adjudication export (t6-adjudication.md).

  python3 tools/quality/score_adjudication.py <export.md> [--runs ~/LuskCorpus/runs/<version>] [--verdicts name=file.json ...]

Sources: `arbiter` (the verdicts in <runs>/<item>/arbiter.json) and any number of `name=file.json` maps
({"<item>:<span id>": {"verdict": "ft"|"base"|...}} or {"pick": ...}, the shapes the second-opinion tools write).
The owner's pick per span is ft / base / same / neither. A source "picks base" when its verdict is base (CTC: pick base);
everything else keeps the fine-tune. Reports, per source: precision of its base picks (owner agrees base), harmful picks
(owner prefers the fine-tune), neutral (owner: both wrong or same), missed base wins (source kept the fine-tune where the
owner prefers base), and plain agreement with the owner.
"""
import argparse, json, os, re, sys


def load_owner(path):
    t = open(os.path.expanduser(path)).read()
    m = re.search(r"```json\n(.*?)\n```", t, re.S)
    return {r["id"]: r for r in json.loads(m.group(1))}


def verdict_of(v):
    v = v.get("verdict", v.get("pick")) if isinstance(v, dict) else v
    return "base" if v == "base" else "ft"


def score(name, picks, owner):
    ids = [i for i in owner if i in picks]
    base = [i for i in ids if picks[i] == "base"]
    prec = [i for i in base if owner[i]["owner"] == "base"]
    harm = [i for i in base if owner[i]["owner"] == "ft"]
    neutral = [i for i in base if owner[i]["owner"] in ("same", "neither")]
    missed = [i for i in ids if picks[i] != "base" and owner[i]["owner"] == "base"]
    # agreement: same side as the owner, with same / neither counting as agreeing with a fine-tune verdict
    agree = [i for i in ids if (picks[i] == "base") == (owner[i]["owner"] == "base")]
    n = len(ids)
    return {"source": name, "spans": n, "basePicks": len(base), "confirmed": len(prec), "harmful": len(harm), "bothWrongOrSame": len(neutral),
            "precision": round(len(prec) / len(base), 3) if base else None, "harmfulRate": round(len(harm) / len(base), 3) if base else None,
            "missedBaseWins": len(missed), "agreementWithOwner": round(len(agree) / n, 3) if n else None,
            "harmfulIds": harm, "missedIds": missed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export")
    ap.add_argument("--runs")
    ap.add_argument("--verdicts", nargs="*", default=[])
    a = ap.parse_args()
    owner = load_owner(a.export)
    out = []
    if a.runs:
        runs = os.path.expanduser(a.runs)
        picks = {}
        for item in sorted(os.listdir(runs)):
            f = os.path.join(runs, item, "arbiter.json")
            if os.path.exists(f):
                for s in json.load(open(f))["spans"]:
                    if s.get("judged") and not s.get("skipped"):
                        picks[f"{item}:{s['id']}"] = verdict_of(s.get("verdict"))
        out.append(score("arbiter", picks, owner))
    for spec in a.verdicts:
        name, f = spec.split("=", 1)
        raw = json.load(open(os.path.expanduser(f)))
        out.append(score(name, {k: verdict_of(v) for k, v in raw.items()}, owner))
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()

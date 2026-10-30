#!/usr/bin/env python3
"""A second opinion on the T6 arbiter that does not share Gemini's ears: which of two transcripts the audio fits
better, by CTC loss under WhisperX's wav2vec2 alignment model (the idea of ~/LuskBatch/tools/review/arbiter.py).

  <managed python env>/bin/python tools/quality/ctc_second_opinion.py <runs>/<version> [--items E64,...] [--out file.json]

Per item reads <runs>/<version>/<item>/arbiter.json and the item's audio (corpus WAV, or ~/LuskBatch/audio/E<nn>.wav),
scores the fine-tune's and the base model's context text over each judged span's audio range, and writes
{"<item>:<span id>": {"ft": loss, "base": loss, "pick": "ft"|"base"}} (lower loss = fits better; a tie is "ft", the
arbiter's own tie rule). Needs the managed Python env (whisperx, torch).
"""
import argparse, json, os, sys

HOME = os.path.expanduser("~")
CORPUS = os.path.join(HOME, "LuskCorpus")
_models = {}


def audio_path(item):
    for p in (os.path.join(CORPUS, item, "audio.wav"), os.path.join(HOME, "LuskBatch", "audio", item + ".wav")):
        if os.path.exists(p):
            return p
    raise SystemExit(f"no audio for {item}")


def load_model(lang):
    import whisperx
    if lang not in _models:
        try:
            _models[lang] = whisperx.load_align_model(language_code=lang, device="cpu", model_cache_only=True)
        except Exception:
            _models[lang] = whisperx.load_align_model(language_code=lang, device="cpu")
    return _models[lang]


def loss(model, meta, audio, t0, t1, text):
    import torch
    d = meta["dictionary"]
    clean = " ".join(text.lower().replace("-", " ").replace("**", "").split())
    ids = [d["|" if c == " " else c] for c in clean if (c == " " or c in d)]
    if not ids:
        return float("inf")
    wav = torch.tensor(audio[int(t0 * 16000):int(t1 * 16000)])[None]
    with torch.inference_mode():
        em = torch.log_softmax(model(wav).logits, dim=-1)[0]
    return torch.nn.functional.ctc_loss(em[:, None], torch.tensor([ids]), torch.tensor([em.shape[0]]), torch.tensor([len(ids)]),
                                        blank=d.get("[pad]", d.get("<pad>", 0)), reduction="sum", zero_infinity=True).item() / max(len(ids), 1)


def main():
    import whisperx
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--items")
    ap.add_argument("--out")
    args = ap.parse_args()
    run_dir = os.path.expanduser(args.run_dir)
    items = args.items.split(",") if args.items else sorted(i for i in os.listdir(run_dir) if os.path.exists(os.path.join(run_dir, i, "arbiter.json")))
    out = {}
    for item in items:
        doc = json.load(open(os.path.join(run_dir, item, "arbiter.json")))
        model, meta = load_model(doc.get("language", "sk"))
        audio = whisperx.load_audio(audio_path(item))
        n = 0
        for sp in doc["spans"]:
            if sp.get("skipped") or not sp.get("judged"):
                continue
            lf = loss(model, meta, audio, sp["t0"], sp["t1"], sp["ftContext"])
            lb = loss(model, meta, audio, sp["t0"], sp["t1"], sp["baseContext"])
            out[f"{item}:{sp['id']}"] = {"ft": round(lf, 4), "base": round(lb, 4), "pick": "base" if lb < lf else "ft"}
            n += 1
        print(f"{item}: {n} spans", file=sys.stderr)
    json.dump(out, open(os.path.expanduser(args.out), "w"), indent=0) if args.out else print(json.dumps(out))


if __name__ == "__main__":
    main()

"""Transcribe an audio file and align every word with WhisperX.

Transcription runs on the Apple GPU through mlx-whisper (Metal): on an M-series Mac that
is ~6x faster than WhisperX's own faster-whisper backend, which has no Metal support and
runs int8 on the CPU. Word timings still come from WhisperX's wav2vec2 forced alignment,
exactly as before. Where MLX is unavailable, WhisperX transcribes as it always did.

Writes WhisperX's JSON shape ({"segments": [{start, end, text, words: [...]}]}) to --out.
Progress for the host app: tqdm bars (`NN%|`) on stderr, and a `PHASE <name>` line on
stdout when the work moves on to the next stage.
"""

import argparse
import json
import re
import sys

MLX_MODELS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}

# Whisper fine-tuned on one language: (Hugging Face transformers checkpoint, its language, the base
# model). KInIT's Slovak turbo (MIT) heard the show far better than turbo itself (2026-10-15, judged by
# listening: E00, a conversation with no script, 257 spans better / 58 worse; E08 14 / 5), but it has
# forgotten every other language. Speech the base model identifies as another language (the Czech
# closing appeal, an English clip) is transcribed by the base model in that language.
LANGUAGE_MODELS = {
    "large-v3-turbo-sk": ("kinit/whisper-large-v3-turbo-sk", "sk", "large-v3-turbo"),
    # Czech large-v3 fine-tune on Common Voice 13 (Apache-2.0), T9 candidate
    "large-v3-cs": ("mikr/whisper-large-v3-czech-cv13", "cs", "large-v3"),
}
# A chunk goes to the base model only when it is clearly another language: Slovak and Czech are
# close, and the base model gives Slovak speech some Czech probability too.
OTHER_LANGUAGE_MIN_P = 0.6


def phase(name: str) -> None:
    print(f"PHASE {name}", flush=True)


VAD_ONSET, VAD_OFFSET = 0.500, 0.363  # WhisperX's own defaults
VAD_CHUNK_S = 30  # speech turns are joined into chunks up to Whisper's window
VAD_PAD_S = 0.2  # so a soft first or last syllable isn't clipped
VAD_JOIN_GAP_S = 2.0  # ...but not across a longer pause, which is often music
HOLE_MARGIN_S = 0.5  # Whisper's segment times are this loose
HOLE_MIN_S = 1.0  # uncovered speech this long is decoded again on its own (E66 12:39, 1.3 s)
MAX_CHARS_PER_S = 30  # fast Slovak speech is ~15-20; a segment denser than this has a wrong end time

# What Whisper writes over music, silence or a window's end: the sign-off of the videos it
# was trained on. Never once spoken in the show's 79 episodes (each case checked against
# the audio on 2026-10-10), so a segment that is nothing but one of these is dropped.
STOCK_PHRASES = {
    "dakujem za pozornost", "dakujeme za pozornost", "dakujem za pozretie",
    "dakujem za sledovanie", "dakujeme za sledovanie", "thank you for watching",
    "thank you for your attention",
    # the Czech fine-tune (T9) writes this over the quiet end of a talk (w6O75HIIRh0 33:42, four times)
    "titulky vytvoril johnyx",
}


# Letters Slovak never uses: Whisper now and then writes a Cyrillic word into Slovak speech
# (E00 17:25 "Kцési."); the segment is dropped and its speech decoded again.
FOREIGN_SCRIPT = re.compile("[\u0400-\u04FF\u0590-\u06FF\u3040-\u30FF\u4E00-\u9FFF]")


def is_loop(text: str) -> bool:
    """Whisper stuck repeating itself: a unit of 1-4 words five times or more in a row (the Slovak
    model, E00 37:10: "Tak," 24 times over speech turbo heard as "No, tak bude vedieť...")."""
    words = plain_words(text)
    for n in range(1, 5):
        for i in range(len(words) - 5 * n + 1):
            unit = words[i:i + n]
            if all(words[i + k * n:i + (k + 1) * n] == unit for k in range(1, 5)):
                return True
    return False


def is_stock_phrase(text: str) -> bool:
    words = plain_words(text)
    # one phrase, or the same one over and over ("Ďakujem za pozornosť. Ďakujem za pozornosť.")
    for phrase in STOCK_PHRASES:
        n = len(phrase.split())
        if words and len(words) % n == 0 and words == phrase.split() * (len(words) // n):
            return True
    return False


def speech_turns(audio) -> list[tuple[float, float]]:
    """Where someone speaks — WhisperX's pyannote VAD, the step its own transcriber runs
    first and the MLX path skipped."""
    import warnings

    import torch
    from whisperx.audio import SAMPLE_RATE

    with warnings.catch_warnings():  # torchcodec: it decodes files, the audio is passed in memory
        warnings.simplefilter("ignore")
        from whisperx.vads import Pyannote
        from whisperx.vads.pyannote import Binarize

    vad = Pyannote(torch.device("cpu"), vad_onset=VAD_ONSET, vad_offset=VAD_OFFSET)
    scores = vad({"waveform": Pyannote.preprocess_audio(audio), "sample_rate": SAMPLE_RATE})
    binarize = Binarize(max_duration=VAD_CHUNK_S, onset=VAD_ONSET, offset=VAD_OFFSET)
    return [(t.start, t.end) for t in binarize(scores).get_timeline()]


def join_turns(turns: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Neighbouring turns joined into chunks up to Whisper's 30 s window, so decoding keeps
    the context across a breath (WhisperX's merge_chunks, minus the music between turns)."""
    chunks: list[list[float]] = []
    for start, end in turns:
        if chunks and end - chunks[-1][0] <= VAD_CHUNK_S and start - chunks[-1][1] <= VAD_JOIN_GAP_S:
            chunks[-1][1] = end
        else:
            chunks.append([start, end])
    return [(s, e) for s, e in chunks]


def as_clips(regions: list[tuple[float, float]], total: float) -> list[float]:
    """The flat [start, end, start, end, ...] list mlx-whisper's `clip_timestamps` takes,
    each region padded without running into the next."""
    flat: list[float] = []
    for start, end in regions:
        start, end = max(0.0, start - VAD_PAD_S, flat[-1] if flat else 0.0), min(total, end + VAD_PAD_S)
        if end > start:
            flat += [start, end]
    return flat


def uncovered(turns: list[tuple[float, float]], segments: list[dict]) -> list[tuple[float, float]]:
    """Speech no transcribed segment covers."""
    spans = sorted((s["start"] - HOLE_MARGIN_S, s["end"] + HOLE_MARGIN_S) for s in segments)
    holes = []
    for start, end in turns:
        pos = start
        for a, b in spans:
            if b <= pos or a >= end:
                continue
            if a - pos >= HOLE_MIN_S:
                holes.append((pos, a))
            pos = max(pos, b)
        if end - pos >= HOLE_MIN_S:
            holes.append((pos, end))
    return holes


_resolved: dict[str, str] = {}


def cached(repo: str) -> str:
    """The local snapshot of a Hugging Face repo, downloaded only when it isn't cached. Given a repo
    name, mlx-whisper asked the hub for updates on every load, and one such request hung in its TLS
    handshake for 38 minutes (E66, 2026-10-15)."""
    from pathlib import Path

    if Path(repo).exists():
        return repo
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        return snapshot_download(repo_id=repo)


def mlx_model(name: str) -> str:
    """The local folder mlx-whisper loads for a model name. A fine-tuned transformers checkpoint is
    downloaded and converted to MLX once (Apple's mlx-examples whisper/convert.py, MIT: rename the
    weights, put the conv kernels last, float16)."""
    if name not in _resolved:
        _resolved[name] = _mlx_model(name)
    return _resolved[name]


def _mlx_model(name: str) -> str:
    if name not in LANGUAGE_MODELS:
        return cached(MLX_MODELS.get(name, name))
    import os
    from pathlib import Path

    repo = LANGUAGE_MODELS[name][0]
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    out = hf_home / "lusk-mlx" / repo.replace("/", "--")
    if (out / "weights.safetensors").exists() and (out / "config.json").exists():
        return str(out)

    import mlx.core as mx
    from huggingface_hub import snapshot_download

    phase("download:model")
    src = Path(snapshot_download(repo_id=repo, allow_patterns=["config.json", "model.safetensors"]))
    hf = json.loads((src / "config.json").read_text())
    config = {
        "n_mels": hf["num_mel_bins"], "n_audio_ctx": hf["max_source_positions"], "n_audio_state": hf["d_model"],
        "n_audio_head": hf["encoder_attention_heads"], "n_audio_layer": hf["encoder_layers"],
        "n_vocab": hf["vocab_size"], "n_text_ctx": hf["max_target_positions"], "n_text_state": hf["d_model"],
        "n_text_head": hf["decoder_attention_heads"], "n_text_layer": hf["decoder_layers"], "model_type": "whisper",
    }
    renames = [("model.", ""), (".layers", ".blocks"), (".self_attn", ".attn"), (".attn_layer_norm", ".attn_ln"),
               (".encoder_attn.", ".cross_attn."), (".encoder_attn_layer_norm", ".cross_attn_ln"),
               (".final_layer_norm", ".mlp_ln"), (".q_proj", ".query"), (".k_proj", ".key"), (".v_proj", ".value"),
               (".out_proj", ".out"), (".fc1", ".mlp1"), (".fc2", ".mlp2"),
               ("embed_positions.weight", "positional_embedding"), ("decoder.embed_tokens", "decoder.token_embedding"),
               ("encoder.layer_norm", "encoder.ln_post"), ("decoder.layer_norm", "decoder.ln")]
    weights = {}
    for key, value in mx.load(str(src / "model.safetensors")).items():
        if key == "proj_out.weight":  # tied to the token embedding
            continue
        for a, b in renames:
            key = key.replace(a, b)
        if key == "encoder.positional_embedding":  # sinusoidal, computed by the model
            continue
        if "conv" in key and value.ndim == 3:
            value = value.swapaxes(1, 2)
        weights[key] = value.astype(mx.float16)
    out.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(out / "weights.partial.safetensors"), weights)
    (out / "config.json").write_text(json.dumps(config, indent=2))
    (out / "weights.partial.safetensors").rename(out / "weights.safetensors")
    return str(out)


def chunk_languages(audio, chunks: list[tuple[float, float]], base: str, own: str) -> list[str]:
    """The language of each chunk (or segment), as the base model identifies it: `own` unless
    another language is clearly more likely."""
    import mlx.core as mx
    from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.transcribe import ModelHolder
    from whisperx.audio import SAMPLE_RATE

    model = ModelHolder.get_model(mlx_model(base), mx.float16)
    found = []
    for start, end in chunks:
        clip = audio[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]
        mel = pad_or_trim(log_mel_spectrogram(clip, n_mels=model.dims.n_mels, padding=N_SAMPLES), N_FRAMES, axis=-2)
        _, probs = model.detect_language(mel.astype(mx.float16))
        best = max(probs, key=probs.get)
        found.append(best if best != own and probs[best] >= OTHER_LANGUAGE_MIN_P else own)
    return found


def transcribe_mlx(audio, model: str, language: str) -> list[dict] | None:
    """Only the speech is decoded. Fed whole 30 s windows, Whisper read music, silence and
    the outro sting as speech: a window that began in a music bed came back as one
    invented "Ďakujem za pozornosť." and the speech after the music was skipped with it
    (E42's and E43's appeal, 15-27 s of narration in E08, E47, E66, E67). Speech that a
    stock phrase still swallowed is decoded once more on its own."""
    try:
        import mlx_whisper
    except ImportError:
        return None
    import mlx.core as mx
    from whisperx.audio import SAMPLE_RATE

    # Dozens of short decodes grew MLX's buffer cache by ~1.7 GB (E66: peak 6.3 GB → 4.6 GB capped)
    mx.set_cache_limit(512 * 2**20)
    phase("vad")
    turns = speech_turns(audio)
    total = len(audio) / SAMPLE_RATE

    def decode(regions, model=model, language=language, bar=None):
        """Each chunk is decoded from its own slice of the audio. mlx-whisper's own
        `clip_timestamps` never seeks to a clip's start — every clip is decoded from where
        the previous one ended, the music between them included (E47, E67: sentences after
        a music bed were lost again)."""
        import tqdm

        clips = as_clips(regions, total)
        spans = list(zip(clips[::2], clips[1::2]))
        segments = []
        # one bar over all chunks, counted in frames like mlx-whisper's own (the host parses it)
        own = bar is None
        if own:
            bar = tqdm.tqdm(total=round(sum(b - a for a, b in spans) * 100), unit="frames")
        try:
            for start, end in spans:
                clip = audio[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]
                mx.clear_cache()
                result = mlx_whisper.transcribe(
                    clip,
                    path_or_hf_repo=mlx_model(model),
                    language=language,
                    # Feeding each window the previous one's text is what lets Whisper fall into
                    # a repetition loop on long recordings; podcasts gain little from it in return.
                    condition_on_previous_text=False,
                    verbose=None,  # no per-chunk bar
                )
                length = end - start
                base = LANGUAGE_MODELS.get(model, (None, None, None))[2]
                if base and any(is_loop(s["text"]) for s in result["segments"]):
                    # a fine-tuned model stuck in a loop: the chunk is decoded by the base model instead
                    print(f"repetition loop at {start:.0f} s: base model", file=sys.stderr)
                    result = mlx_whisper.transcribe(clip, path_or_hf_repo=mlx_model(base), language=language,
                                                    condition_on_previous_text=False, verbose=None)
                found = result["segments"]
                for i, s in enumerate(found):
                    # Whisper now and then stamps a long passage over a second or two (E53 11:22: 20 s
                    # of speech as 681.9-684.4); aligned inside that span, all its words were dropped.
                    # Such a segment runs on to the next one, or to the clip's end.
                    if len(s["text"].strip()) > MAX_CHARS_PER_S * max(s["end"] - s["start"], 1e-3):
                        s["end"] = max(s["end"], min(found[i + 1]["start"] if i + 1 < len(found) else length, length))
                for s in found:
                    # Past the clip's end Whisper's window is padded with silence, and what it
                    # "hears" there is invented (E42: "Zdravíte!" stretched over the 30 s after a
                    # chunk that ended in music): keep a segment only if most of it is real audio.
                    inside = max(0.0, min(s["end"], length) - max(s["start"], 0.0)) / max(s["end"] - s["start"], 1e-3)
                    if inside >= 0.5 and not is_stock_phrase(s["text"]) and not FOREIGN_SCRIPT.search(s["text"]):
                        segments.append({"start": start + s["start"], "end": min(start + s["end"], end), "text": s["text"],
                                         "language": language})
                bar.update(round(length * 100))
        finally:
            if own:
                bar.close()
        return segments

    def routed(chunks):
        """A fine-tuned model decodes its own language; the base model every chunk in another one."""
        if model not in LANGUAGE_MODELS or language != LANGUAGE_MODELS[model][1]:
            return decode(chunks)
        import tqdm

        base = LANGUAGE_MODELS[model][2]
        langs = chunk_languages(audio, chunks, base, language)
        others = sorted({l for l in langs if l != language})
        if others:
            print(f"{sum(l != language for l in langs)} of {len(chunks)} chunks in {', '.join(others)}: base model", file=sys.stderr)
        clips = as_clips(chunks, total)
        with tqdm.tqdm(total=round(sum(b - a for a, b in zip(clips[::2], clips[1::2])) * 100), unit="frames") as bar:
            segments = decode([c for c, l in zip(chunks, langs) if l == language], bar=bar)
            foreign = []
            for other in others:
                foreign += decode([c for c, l in zip(chunks, langs) if l == other], base, other, bar=bar)
        # a chunk is up to 30 s: a sentence of the own language inside a foreign chunk (the line before
        # E35's Czech appeal, "A jediné miesto…", came back as Czech "město") is decoded again by the fine-tune
        if foreign:
            again = [(s["start"], s["end"]) for s, l in zip(foreign, chunk_languages(audio, [(s["start"], s["end"]) for s in foreign], base, language)) if l == language]
            if again:
                print(f"{len(again)} of {len(foreign)} sentences in those chunks are {language}: fine-tuned model", file=sys.stderr)
                foreign = [s for s in foreign if (s["start"], s["end"]) not in again]
                segments += decode(again)
            segments += foreign
        return segments

    phase("transcribe:mlx")
    segments = routed(join_turns(turns))
    holes = uncovered(turns, segments)
    if holes:
        print(f"decoding {len(holes)} uncovered speech stretches again ({sum(b - a for a, b in holes):.0f} s)", file=sys.stderr)
        segments += [s for s in routed(join_turns(holes)) if not already_said(s, segments)]
    return join_sentences(sorted(segments, key=lambda s: s["start"]))


def join_sentences(segments: list[dict]) -> list[dict]:
    """Each chunk is decoded alone, so Whisper ends it with a full stop even where the speaker only
    paused mid-sentence; it starts the next chunk in lower case when it hears the sentence go on
    (E00, a conversation: "prvý rozhovor. z ...", "okolo seba. politikov"). That stop is dropped."""
    for seg, nxt in zip(segments, segments[1:]):
        text, following = seg["text"].rstrip(), nxt["text"].lstrip()
        last = text.split()[-1].lower() if text.split() else ""
        # an ordinal ("v 20." storočí) or an abbreviation ("napr.") needs its dot
        if last[:-1].isdigit() or last[:-1] in ABBREVIATIONS:
            continue
        if text.endswith(".") and not text.endswith("..") and following[:1].islower():
            seg["text"] = text[:-1]
    return segments


ABBREVIATIONS = {"napr", "tzv", "atď", "resp", "tj", "sv", "str", "č", "kap", "porov", "pozn", "dr", "mr", "st", "kr", "pr", "vs"}


def plain_words(text: str) -> list[str]:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFD", text.lower()) if c.isalnum() or c.isspace()).split()


def already_said(seg: dict, segments: list[dict]) -> bool:
    """A second-pass segment whose words a neighbour already has — its segment times were
    looser than the margin — would show twice."""
    words = " ".join(plain_words(seg["text"]))
    near = [s for s in segments if s["end"] > seg["start"] - 5 and s["start"] < seg["end"] + 5]
    return bool(words) and any(words in " ".join(plain_words(s["text"])) for s in near)


def transcribe_whisperx(audio, model: str, language: str) -> list[dict]:
    import whisperx

    model = LANGUAGE_MODELS.get(model, (None, None, model))[2]  # faster-whisper has only the base models

    phase("transcribe:whisperx")
    asr = whisperx.load_model(model, "cpu", compute_type="int8", language=language)
    result = asr.transcribe(audio, batch_size=8, language=language, print_progress=True)
    return result["segments"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe + word-align with WhisperX")
    parser.add_argument("audio")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default="sk")
    parser.add_argument("--engine", choices=["auto", "mlx", "whisperx"], default="auto")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import whisperx

    audio = whisperx.load_audio(args.audio)

    segments = None
    if args.engine in ("auto", "mlx"):
        segments = transcribe_mlx(audio, args.model, args.language)
        if segments is None:
            if args.engine == "mlx":
                sys.exit("mlx-whisper is not installed")
            print("mlx-whisper unavailable, transcribing with WhisperX", file=sys.stderr)
    if segments is None:
        segments = transcribe_whisperx(audio, args.model, args.language)

    phase("align")
    try:  # the cached model, without asking the hub (see `cached`)
        align_model, metadata = whisperx.load_align_model(language_code=args.language, device="cpu", model_cache_only=True)
    except Exception:
        align_model, metadata = whisperx.load_align_model(language_code=args.language, device="cpu")
    aligned = whisperx.align(segments, align_model, metadata, audio, "cpu",
                             return_char_alignments=False, print_progress=True)

    # each aligned segment keeps the language it was decoded in (by overlap with the decoded ones):
    # the host leaves speech in another language as it was heard, never "corrected" into this one
    for seg in aligned["segments"]:
        lang = max(segments, key=lambda s: min(s["end"], seg["end"]) - max(s["start"], seg["start"]), default={}).get("language")
        if lang and lang != args.language:
            seg["language"] = lang
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"segments": aligned["segments"]}, f, ensure_ascii=False)
    phase("done")


if __name__ == "__main__":
    main()

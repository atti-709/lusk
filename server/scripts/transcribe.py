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
import sys

MLX_MODELS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


def phase(name: str) -> None:
    print(f"PHASE {name}", flush=True)


VAD_ONSET, VAD_OFFSET = 0.500, 0.363  # WhisperX's own defaults
VAD_CHUNK_S = 30  # speech turns are joined into chunks up to Whisper's window
VAD_PAD_S = 0.2  # so a soft first or last syllable isn't clipped
VAD_JOIN_GAP_S = 2.0  # ...but not across a longer pause, which is often music
HOLE_MARGIN_S = 0.5  # Whisper's segment times are this loose
HOLE_MIN_S = 1.0  # uncovered speech this long is decoded again on its own (E66 12:39, 1.3 s)

# What Whisper writes over music, silence or a window's end: the sign-off of the videos it
# was trained on. Never once spoken in the show's 79 episodes (each case checked against
# the audio on 2026-10-10), so a segment that is nothing but one of these is dropped.
STOCK_PHRASES = {
    "dakujem za pozornost", "dakujeme za pozornost", "dakujem za pozretie",
    "dakujem za sledovanie", "dakujeme za sledovanie", "thank you for watching",
    "thank you for your attention",
}


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

    def decode(regions):
        """Each chunk is decoded from its own slice of the audio. mlx-whisper's own
        `clip_timestamps` never seeks to a clip's start — every clip is decoded from where
        the previous one ended, the music between them included (E47, E67: sentences after
        a music bed were lost again)."""
        import tqdm

        clips = as_clips(regions, total)
        spans = list(zip(clips[::2], clips[1::2]))
        segments = []
        # one bar over all chunks, counted in frames like mlx-whisper's own (the host parses it)
        with tqdm.tqdm(total=round(sum(b - a for a, b in spans) * 100), unit="frames") as bar:
            for start, end in spans:
                clip = audio[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]
                mx.clear_cache()
                result = mlx_whisper.transcribe(
                    clip,
                    path_or_hf_repo=MLX_MODELS.get(model, model),
                    language=language,
                    # Feeding each window the previous one's text is what lets Whisper fall into
                    # a repetition loop on long recordings; podcasts gain little from it in return.
                    condition_on_previous_text=False,
                    verbose=None,  # no per-chunk bar
                )
                length = end - start
                for s in result["segments"]:
                    # Past the clip's end Whisper's window is padded with silence, and what it
                    # "hears" there is invented (E42: "Zdravíte!" stretched over the 30 s after a
                    # chunk that ended in music): keep a segment only if most of it is real audio.
                    inside = max(0.0, min(s["end"], length) - max(s["start"], 0.0)) / max(s["end"] - s["start"], 1e-3)
                    if inside >= 0.5 and not is_stock_phrase(s["text"]):
                        segments.append({"start": start + s["start"], "end": min(start + s["end"], end), "text": s["text"]})
                bar.update(round(length * 100))
        return segments

    phase("transcribe:mlx")
    segments = decode(join_turns(turns))
    holes = uncovered(turns, segments)
    if holes:
        print(f"decoding {len(holes)} uncovered speech stretches again ({sum(b - a for a, b in holes):.0f} s)", file=sys.stderr)
        segments += [s for s in decode(join_turns(holes)) if not already_said(s, segments)]
    return sorted(segments, key=lambda s: s["start"])


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
    align_model, metadata = whisperx.load_align_model(language_code=args.language, device="cpu")
    aligned = whisperx.align(segments, align_model, metadata, audio, "cpu",
                             return_char_alignments=False, print_progress=True)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"segments": aligned["segments"]}, f, ensure_ascii=False)
    phase("done")


if __name__ == "__main__":
    main()

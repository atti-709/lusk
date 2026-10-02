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


def transcribe_mlx(audio_path: str, model: str, language: str) -> list[dict] | None:
    try:
        import mlx_whisper
    except ImportError:
        return None
    phase("transcribe:mlx")
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=MLX_MODELS.get(model, model),
        language=language,
        # Feeding each window the previous one's text is what lets Whisper fall into a
        # repetition loop on long recordings; podcasts gain little from it in return.
        condition_on_previous_text=False,
        verbose=False,  # tqdm progress bar on stderr
    )
    return [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in result["segments"]]


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
        segments = transcribe_mlx(args.audio, args.model, args.language)
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

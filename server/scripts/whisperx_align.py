"""
WhisperX forced alignment — takes whisper.cpp segments and produces
word-level timestamps using wav2vec2.

Usage: python3 -u whisperx_align.py <audio.wav> <segments.json> <output.json>

segments.json format:
  [{"start": 0.0, "end": 5.2, "text": "Hello world"}, ...]

output.json format:
  {"segments": [{"start": 0.0, "end": 5.2, "text": "...", "words": [...]}]}
"""

import sys
import json

audio_path = sys.argv[1]
segments_path = sys.argv[2]
output_path = sys.argv[3]

import whisperx

with open(segments_path) as f:
    segments = json.load(f)

# Filter out segments that are too short or empty — they cause
# ZeroDivisionError inside WhisperX's CTC trellis computation.
MIN_DURATION = 0.15  # seconds
filtered = [
    s for s in segments
    if s.get("text", "").strip() and (s["end"] - s["start"]) >= MIN_DURATION
]

print("ALIGN_STAGE: loading_audio", flush=True)
audio = whisperx.load_audio(audio_path)

print("ALIGN_STAGE: loading_model", flush=True)
model_a, metadata = whisperx.load_align_model(language_code="sk", device="cpu")

print("ALIGN_STAGE: aligning", flush=True)
try:
    result = whisperx.align(
        filtered, model_a, metadata, audio,
        device="cpu",
        return_char_alignments=False,
    )
except ZeroDivisionError:
    # Some segments still too short after filtering — fall back to segment-level
    # timestamps (no word-level). The downstream code handles missing word data.
    print("ALIGN_STAGE: fallback_no_word_align", flush=True)
    result = {"segments": filtered}

with open(output_path, "w") as f:
    json.dump(result, f)

print("ALIGN_STAGE: done", flush=True)

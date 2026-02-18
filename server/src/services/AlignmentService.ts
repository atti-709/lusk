import type { TranscriptWord, TranscriptData } from "@lusk/shared";

/**
 * Strip diacritics and lowercase for fuzzy comparison.
 * Handles Slovak characters: č→c, š→s, ž→z, ď→d, ť→t, ň→n, ľ→l, ŕ→r, á→a, é→e, í→i, ó→o, ú→u, ý→y, ô→o
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

interface AlignedWord {
  /** The corrected word from source text (or original if no match) */
  word: string;
  startMs: number;
  endMs: number;
  /** Whether this word was corrected by alignment */
  corrected: boolean;
}

/**
 * Needleman-Wunsch global alignment at word level.
 *
 * Aligns whisper transcript words against source text words.
 * When a whisper word matches a source word (after normalization),
 * the source word's spelling replaces the whisper word — preserving
 * correct diacritics and casing.
 */
export function alignWords(
  whisperWords: TranscriptWord[],
  sourceText: string
): AlignedWord[] {
  const sourceWords = sourceText.split(/\s+/).filter(Boolean);
  if (sourceWords.length === 0) {
    return whisperWords.map((w) => ({ ...w, corrected: false }));
  }

  const n = whisperWords.length;
  const m = sourceWords.length;

  const MATCH = 2;
  const MISMATCH = -1;
  const GAP = -1;

  // Build score matrix
  const score: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );

  for (let i = 0; i <= n; i++) score[i][0] = i * GAP;
  for (let j = 0; j <= m; j++) score[0][j] = j * GAP;

  for (let i = 1; i <= n; i++) {
    const wNorm = normalize(whisperWords[i - 1].word);
    for (let j = 1; j <= m; j++) {
      const sNorm = normalize(sourceWords[j - 1]);
      const diag = score[i - 1][j - 1] + (wNorm === sNorm ? MATCH : MISMATCH);
      const up = score[i - 1][j] + GAP;
      const left = score[i][j - 1] + GAP;
      score[i][j] = Math.max(diag, up, left);
    }
  }

  // Traceback
  const result: AlignedWord[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const wNorm = normalize(whisperWords[i - 1].word);
      const sNorm = normalize(sourceWords[j - 1]);
      const diag = score[i - 1][j - 1] + (wNorm === sNorm ? MATCH : MISMATCH);

      if (score[i][j] === diag) {
        const isMatch = wNorm === sNorm;
        result.push({
          word: isMatch ? sourceWords[j - 1] : whisperWords[i - 1].word,
          startMs: whisperWords[i - 1].startMs,
          endMs: whisperWords[i - 1].endMs,
          corrected: isMatch && whisperWords[i - 1].word !== sourceWords[j - 1],
        });
        i--;
        j--;
        continue;
      }
    }

    if (i > 0 && score[i][j] === score[i - 1][j] + GAP) {
      // Whisper word has no source match — keep as-is
      result.push({
        word: whisperWords[i - 1].word,
        startMs: whisperWords[i - 1].startMs,
        endMs: whisperWords[i - 1].endMs,
        corrected: false,
      });
      i--;
    } else {
      // Source word has no whisper match — skip it
      j--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Align a transcript against source text, returning a corrected TranscriptData.
 */
export function alignTranscript(
  transcript: TranscriptData,
  sourceText: string
): TranscriptData {
  const aligned = alignWords(transcript.words, sourceText);
  return {
    words: aligned.map(({ word, startMs, endMs }) => ({ word, startMs, endMs })),
    text: aligned.map((w) => w.word).join(" "),
  };
}

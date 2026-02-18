import { describe, it, expect } from "vitest";
import {
  normalize,
  alignWords,
  alignTranscript,
} from "../services/AlignmentService.js";
import type { TranscriptWord, TranscriptData } from "@lusk/shared";

describe("normalize", () => {
  it("strips Slovak diacritics", () => {
    expect(normalize("čšžďťňľŕ")).toBe("cszdtnlr");
  });

  it("strips accented vowels", () => {
    expect(normalize("áéíóúýô")).toBe("aeiouyo");
  });

  it("lowercases", () => {
    expect(normalize("Ahoj")).toBe("ahoj");
  });

  it("handles mixed text", () => {
    expect(normalize("Príliš žltučký")).toBe("prilis zltucky");
  });
});

describe("alignWords", () => {
  function makeWords(words: string[]): TranscriptWord[] {
    let ms = 0;
    return words.map((word) => {
      const w = { word, startMs: ms, endMs: ms + 200 };
      ms += 250;
      return w;
    });
  }

  it("corrects diacritics from source text", () => {
    const whisper = makeWords(["ahoj", "vitajte", "v", "dnesnom", "podcaste"]);
    const source = "Ahoj vitajte v dnešnom podcaste";

    const aligned = alignWords(whisper, source);

    expect(aligned[3].word).toBe("dnešnom");
    expect(aligned[3].corrected).toBe(true);
    expect(aligned[3].startMs).toBe(whisper[3].startMs);
  });

  it("preserves timestamps", () => {
    const whisper = makeWords(["jedna", "dva", "tri"]);
    const source = "jedna dva tri";

    const aligned = alignWords(whisper, source);

    for (let i = 0; i < 3; i++) {
      expect(aligned[i].startMs).toBe(whisper[i].startMs);
      expect(aligned[i].endMs).toBe(whisper[i].endMs);
    }
  });

  it("handles extra words in whisper output", () => {
    const whisper = makeWords(["ahoj", "um", "vitajte"]);
    const source = "Ahoj vitajte";

    const aligned = alignWords(whisper, source);

    expect(aligned.length).toBe(3);
    expect(aligned[0].word).toBe("Ahoj");
    expect(aligned[1].word).toBe("um");
    expect(aligned[1].corrected).toBe(false);
    expect(aligned[2].word).toBe("vitajte");
  });

  it("handles extra words in source text", () => {
    const whisper = makeWords(["ahoj", "vitajte"]);
    const source = "Ahoj všetci vitajte";

    const aligned = alignWords(whisper, source);

    expect(aligned.length).toBe(2);
    expect(aligned[0].word).toBe("Ahoj");
    expect(aligned[1].word).toBe("vitajte");
  });

  it("returns original words when source is empty", () => {
    const whisper = makeWords(["ahoj"]);
    const aligned = alignWords(whisper, "");

    expect(aligned[0].word).toBe("ahoj");
    expect(aligned[0].corrected).toBe(false);
  });
});

describe("alignTranscript", () => {
  it("returns corrected TranscriptData", () => {
    const transcript: TranscriptData = {
      words: [
        { word: "dnesny", startMs: 0, endMs: 200 },
        { word: "den", startMs: 250, endMs: 450 },
      ],
      text: "dnesny den",
    };

    const result = alignTranscript(transcript, "Dnešný deň");

    expect(result.words[0].word).toBe("Dnešný");
    expect(result.words[1].word).toBe("deň");
    expect(result.text).toBe("Dnešný deň");
    expect(result.words[0].startMs).toBe(0);
  });
});

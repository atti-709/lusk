import { describe, it, expect } from "vitest";
import { whisperModelFor, LANGUAGE_MODELS } from "../services/WhisperService.js";

describe("whisperModelFor", () => {
  it("uses each language's fine-tune (Slovak KInIT turbo, Czech mikr large-v3)", () => {
    expect(whisperModelFor("sk", undefined)).toBe("large-v3-turbo-sk");
    expect(whisperModelFor("cs", undefined)).toBe("large-v3-cs");
  });

  it("falls back to base turbo for other languages", () => {
    expect(whisperModelFor("en", undefined)).toBe("large-v3-turbo");
  });

  it("lets LUSK_WHISPER_MODEL override the choice", () => {
    expect(whisperModelFor("cs", "large-v3")).toBe("large-v3");
  });

  it("keeps the model names in step with transcribe.py's LANGUAGE_MODELS (the quality tool reads this table as text)", () => {
    expect(Object.keys(LANGUAGE_MODELS).sort()).toEqual(["cs", "sk"]);
  });
});

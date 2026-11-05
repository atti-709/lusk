import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProofreadPrompt, PROOFREAD_LANGUAGE_RULES } from "../services/GeminiService.js";

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "../../../client/public/prompts/proofread-api.md"), "utf-8");

describe("renderProofreadPrompt", () => {
  it("leaves no placeholder behind, for any language", () => {
    for (const lang of ["sk", "cs", "en"]) {
      expect(renderProofreadPrompt(template, lang, null)).not.toMatch(/\{\{/);
      expect(renderProofreadPrompt(template, lang, "text")).not.toMatch(/\{\{/);
    }
  });

  it("template uses every language placeholder exactly once", () => {
    for (const key of Object.keys(PROOFREAD_LANGUAGE_RULES.sk)) expect(template.split(`{{${key}}}`).length - 1).toBe(1);
    expect(Object.keys(PROOFREAD_LANGUAGE_RULES.cs)).toEqual(Object.keys(PROOFREAD_LANGUAGE_RULES.sk));
  });

  it("keeps the Slovak rules 4 and 10 in meaning", () => {
    const sk = renderProofreadPrompt(template, "sk", null);
    expect(sk).toContain('4. **Foreign spellings** — for Slovak, Czech forms that slip in ("protože" → "pretože"');
    expect(sk).toContain('"ó" where Slovak writes "ô"');
    expect(sk).toContain("a passage spoken in Czech");
    expect(sk).toContain('10. **Names** — characters, places and people in their established Slovak spelling');
    expect(sk).toContain("a recording spoken in Slovak");
    expect(sk).not.toContain("video podcast");
    expect(sk).not.toContain("kterej");
  });

  it("the Czech block fixes a single Slovak form, keeps Slovak passages, and never normalises colloquial Czech", () => {
    const cs = renderProofreadPrompt(template, "cs", null);
    expect(cs).toContain("a recording spoken in Czech");
    expect(cs).toContain("a single Slovak form that slips into a Czech sentence");
    expect(cs).toContain("a passage spoken in Slovak");
    for (const form of ["kterej", "zajištěnej", "druhýho", "zhromáždění"]) expect(cs).toContain(form);
    expect(cs).toContain("must never be changed to the standard form");
    expect(cs).not.toContain("for Slovak, Czech forms");
    expect(cs).not.toContain("established Slovak spelling");
    expect(cs).not.toContain('"ô" where Slovak');
  });

  it("an unknown language falls back to the Slovak block, as the prompt did before", () => {
    const en = renderProofreadPrompt(template, "en", null);
    expect(en).toContain("for Slovak, Czech forms that slip in");
    expect(en).toContain("a recording spoken in English");
  });

  it("fills the script note", () => {
    expect(renderProofreadPrompt(template, "cs", "x")).toContain("## Reference script");
    expect(renderProofreadPrompt(template, "cs", null)).not.toContain("## Reference script");
  });
});

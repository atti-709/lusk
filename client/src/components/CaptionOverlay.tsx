import { useMemo } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { TikTokPage, Caption } from "@remotion/captions";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadBangers } from "@remotion/google-fonts/Bangers";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import type { CaptionStyles } from "@lusk/shared";
import { DEFAULT_CAPTION_STYLES } from "@lusk/shared";

type LoadFontFn = (style: string, options?: Record<string, unknown>) => { fontFamily: string };

type FontEntry = {
  load: LoadFontFn;
  weights: number[];
};

export const FONT_REGISTRY: Record<string, FontEntry> = {
  Montserrat:      { load: loadMontserrat as LoadFontFn,    weights: [400, 500, 600, 700, 800, 900] },
  Inter:           { load: loadInter as LoadFontFn,          weights: [400, 500, 600, 700, 800, 900] },
  Oswald:          { load: loadOswald as LoadFontFn,         weights: [400, 500, 600, 700] },
  "Bebas Neue":    { load: loadBebasNeue as LoadFontFn,      weights: [400] },
  Poppins:         { load: loadPoppins as LoadFontFn,        weights: [400, 500, 600, 700, 800, 900] },
  Bangers:         { load: loadBangers as LoadFontFn,        weights: [400] },
  "Space Mono":    { load: loadSpaceMono as LoadFontFn,      weights: [400, 700] },
  "Space Grotesk": { load: loadSpaceGrotesk as LoadFontFn,   weights: [400, 500, 600, 700] },
};

function useFontFamily(fontKey: string): string {
  return useMemo(() => {
    const entry = FONT_REGISTRY[fontKey] ?? FONT_REGISTRY["Montserrat"];
    const { fontFamily } = entry.load("normal", {
      weights: entry.weights.map(String) as ("400" | "500" | "600" | "700" | "800" | "900")[],
      subsets: ["latin", "latin-ext"],
    });
    return fontFamily;
  }, [fontKey]);
}

// How often captions switch — controls words per page
const SWITCH_CAPTIONS_EVERY_MS = 1200;
const SHADOW =
  "0 0 6px rgba(0,0,0,0.8), 0 0 16px rgba(0,0,0,0.5), 0 0 30px rgba(0,0,0,0.3)";

function CaptionPage({ page, styles, fontFamily }: { page: TikTokPage; styles: CaptionStyles; fontFamily: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Current time relative to this Sequence (starts at 0)
  const currentTimeMs = (frame / fps) * 1000;
  // Convert to absolute time by adding the page start
  const absoluteTimeMs = page.startMs + currentTimeMs;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        // Lower third: ~75-80% down the 1920px frame
        paddingBottom: styles.captionPosition,
      }}
    >
      <div
        style={{
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          fontFamily,
          textAlign: "center",
          textTransform: styles.textTransform,
          letterSpacing: "0.02em",
          whiteSpace: "pre-wrap",
          textShadow: SHADOW,
          maxWidth: "85%",
          lineHeight: 1.25,
        }}
      >
        {page.tokens.map((token) => {
          const isActive =
            token.fromMs <= absoluteTimeMs && token.toMs > absoluteTimeMs;

          return (
            <span
              key={token.fromMs}
              style={{
                color: isActive ? styles.highlightColor : styles.textColor,
                transform: isActive ? "scale(1.12)" : "scale(1)",
                display: "inline",
                transition: "transform 0.08s ease, color 0.05s ease",
              }}
            >
              {token.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

export type CaptionOverlayProps = {
  captions: Caption[];
  captionStyles?: CaptionStyles;
};

type TikTokToken = TikTokPage["tokens"][number];

// Abbreviations that end in a period without ending the sentence.
const ABBREVIATIONS = new Set([
  "napr.", "atď.", "atd.", "tzv.", "tj.", "t.j.", "resp.", "cca.", "č.", "c.",
  "str.", "obr.", "tab.", "mil.", "mld.", "tis.", "hod.", "min.", "sek.",
  "st.", "stor.", "roč.", "pozn.", "vs.", "kt.", "spol.", "ul.", "nám.",
  "p.", "prof.", "doc.", "dr.", "mudr.", "ing.", "mgr.", "phdr.", "judr.", "bc.",
  "s.r.o.", "a.s.",
]);

// Opening punctuation that can precede the first letter of a sentence
const LEADING_PUNCTUATION = /^[„“"'(\[–—-]+/;

function startsUppercase(text: string): boolean {
  const first = text.replace(LEADING_PUNCTUATION, "").trim()[0];
  if (!first) return false;
  // Letters only — a digit has no case, so `toUpperCase()` leaves it unchanged
  return first === first.toLocaleUpperCase("sk") && first !== first.toLocaleLowerCase("sk");
}

/**
 * A trailing period is not enough: Slovak writes ordinals with one ("v 19. storočí",
 * "5. marca", "2. miesto"), as do abbreviations. Splitting on those strands the number
 * on a page of its own. Require the next token to start a new sentence instead.
 */
function isSentenceEnd(token: TikTokToken, next: TikTokToken | undefined): boolean {
  const text = token.text.trim();
  if (/[!?]$/.test(text)) return true;
  if (!text.endsWith(".")) return false;
  if (ABBREVIATIONS.has(text.toLocaleLowerCase("sk"))) return false;
  return next ? startsUppercase(next.text) : true;
}

function makePage(chunk: TikTokToken[]): TikTokPage {
  // `createTikTokStyleCaptions` strips the leading space off a page's first token and
  // leaves it on every other one. Regrouping changes which token is first, so re-normalise
  // — otherwise a page starts with a stray space or two words run together.
  const tokens = chunk.map((t, i) => {
    const text = i === 0 ? t.text.trimStart() : /^\s/.test(t.text) ? t.text : ` ${t.text}`;
    return text === t.text ? t : { ...t, text };
  });
  const last = tokens[tokens.length - 1];
  return {
    startMs: tokens[0].fromMs,
    tokens,
    text: tokens.map((t) => t.text).join(""),
    durationMs: last.toMs - tokens[0].fromMs,
  };
}

/**
 * Split pages at sentence boundaries so the last word of a sentence
 * and the first word of the next never appear on screen together.
 */
function splitAtSentenceBoundaries(pages: TikTokPage[]): TikTokPage[] {
  const result: TikTokPage[] = [];

  for (const page of pages) {
    const { tokens } = page;
    if (tokens.length <= 1) {
      result.push(page);
      continue;
    }

    // Find split points: after tokens that end a sentence
    let chunkStart = 0;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (isSentenceEnd(tokens[i], tokens[i + 1])) {
        result.push(makePage(tokens.slice(chunkStart, i + 1)));
        chunkStart = i + 1;
      }
    }

    // Push remaining tokens as the last chunk
    if (chunkStart < tokens.length) {
      result.push(chunkStart === 0 ? page : makePage(tokens.slice(chunkStart)));
    }
  }

  return result;
}

/** `19.`, `5.` — an ordinal belongs with the noun that follows it. */
const ORDINAL = /^\d+\.$/;
/** `1`, `500`, `2,5`, `1.000` — a bare numeric group. */
const NUMERIC = /^\d[\d.,]*$/;

/**
 * True when `token` must not be the last thing on a page — it reads as broken
 * without the word after it.
 */
function stickyToNext(token: TikTokToken, next: TikTokToken): boolean {
  const text = token.text.trim();
  const nextText = next.text.trim();
  // A year that closes a sentence ("…v roku 1990. Potom…") belongs to the page it ends
  if (isSentenceEnd(token, next)) return false;
  if (ORDINAL.test(text)) return true;
  if (ABBREVIATIONS.has(text.toLocaleLowerCase("sk"))) return true;
  // A number spelled in groups ("1 500") must not straddle a page break
  return NUMERIC.test(text) && NUMERIC.test(nextText);
}

/**
 * `createTikTokStyleCaptions` breaks pages purely on elapsed time, which can leave a
 * page ending on a number that belongs with the next word. Push those trailing tokens
 * onto the following page.
 */
function keepNumbersWhole(pages: TikTokPage[]): TikTokPage[] {
  const result: TikTokPage[] = [];

  // Walk backwards so a token moved onto the next page can itself pull the one before it
  for (let i = pages.length - 1; i >= 0; i--) {
    let tokens = pages[i].tokens;

    while (result.length > 0 && tokens.length > 0 &&
           stickyToNext(tokens[tokens.length - 1], result[0].tokens[0])) {
      result[0] = makePage([tokens[tokens.length - 1], ...result[0].tokens]);
      tokens = tokens.slice(0, -1);
    }

    // The page may have been emptied into its successor
    if (tokens.length > 0) {
      result.unshift(tokens === pages[i].tokens ? pages[i] : makePage(tokens));
    }
  }

  return result;
}

export function CaptionOverlay({ captions, captionStyles }: CaptionOverlayProps) {
  const styles = captionStyles ?? DEFAULT_CAPTION_STYLES;
  const fontFamily = useFontFamily(styles.fontFamily);
  const { fps } = useVideoConfig();

  const pages = useMemo(() => {
    const { pages } = createTikTokStyleCaptions({
      captions,
      combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,
    });
    return keepNumbersWhole(splitAtSentenceBoundaries(pages));
  }, [captions]);

  return (
    <AbsoluteFill>
      {pages.map((page, index) => {
        const nextPage = pages[index + 1] ?? null;
        const startFrame = (page.startMs / 1000) * fps;
        const lastToken = page.tokens[page.tokens.length - 1];
        const endMs = lastToken ? lastToken.toMs : page.startMs + SWITCH_CAPTIONS_EVERY_MS;
        const naturalEndFrame = (endMs / 1000) * fps;

        const endFrame = nextPage 
          ? Math.min((nextPage.startMs / 1000) * fps, naturalEndFrame)
          : naturalEndFrame;
        const durationInFrames = endFrame - startFrame;

        if (durationInFrames <= 0) return null;

        return (
          <Sequence
            key={index}
            from={startFrame}
            durationInFrames={durationInFrames}
          >
            <CaptionPage page={page} styles={styles} fontFamily={fontFamily} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

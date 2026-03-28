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
  "0 2px 8px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)";

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

    // Find split points: after tokens whose text ends with sentence punctuation
    let chunkStart = 0;
    for (let i = 0; i < tokens.length; i++) {
      const endsWithPunctuation = /[.!?]$/.test(tokens[i].text.trim());
      const isLastToken = i === tokens.length - 1;

      if (endsWithPunctuation && !isLastToken) {
        // Split here: tokens[chunkStart..i] become one page
        const chunk = tokens.slice(chunkStart, i + 1);
        const lastChunkToken = chunk[chunk.length - 1];
        result.push({
          startMs: chunk[0].fromMs,
          tokens: chunk,
          text: chunk.map((t) => t.text).join(""),
          durationMs: lastChunkToken.toMs - chunk[0].fromMs,
        });
        chunkStart = i + 1;
      }
    }

    // Push remaining tokens as the last chunk
    if (chunkStart < tokens.length) {
      const chunk = tokens.slice(chunkStart);
      const lastChunkToken = chunk[chunk.length - 1];
      result.push({
        startMs: chunk[0].fromMs,
        tokens: chunk,
        text: chunk.map((t) => t.text).join(""),
        durationMs: lastChunkToken.toMs - chunk[0].fromMs,
      });
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
    return splitAtSentenceBoundaries(pages);
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

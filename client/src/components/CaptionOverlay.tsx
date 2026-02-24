import { useMemo } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { createTikTokStyleCaptions } from "@remotion/captions";
import type { TikTokPage, Caption } from "@remotion/captions";
import { loadFont } from "@remotion/google-fonts/Montserrat";

const { fontFamily } = loadFont("normal", {
  weights: ["800", "900"],
  subsets: ["latin", "latin-ext"],
});

// How often captions switch — controls words per page
const SWITCH_CAPTIONS_EVERY_MS = 1200;
const HIGHLIGHT_COLOR = "#F77205";
const TEXT_COLOR = "#ffffff";
const SHADOW =
  "0 2px 8px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)";

function CaptionPage({ page }: { page: TikTokPage }) {
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
        paddingBottom: 340,
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 900,
          fontFamily,
          textAlign: "center",
          textTransform: "uppercase",
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
                color: isActive ? HIGHLIGHT_COLOR : TEXT_COLOR,
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

export function CaptionOverlay({ captions }: CaptionOverlayProps) {
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
            <CaptionPage page={page} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

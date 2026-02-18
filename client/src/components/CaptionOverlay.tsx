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

export function CaptionOverlay({ captions }: CaptionOverlayProps) {
  const { fps } = useVideoConfig();

  const pages = useMemo(() => {
    const { pages } = createTikTokStyleCaptions({
      captions,
      combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,
    });
    return pages;
  }, [captions]);

  return (
    <AbsoluteFill>
      {pages.map((page, index) => {
        const nextPage = pages[index + 1] ?? null;
        const startFrame = (page.startMs / 1000) * fps;
        const endFrame = Math.min(
          nextPage ? (nextPage.startMs / 1000) * fps : Infinity,
          startFrame + (SWITCH_CAPTIONS_EVERY_MS / 1000) * fps,
        );
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

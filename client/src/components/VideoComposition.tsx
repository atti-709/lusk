import { AbsoluteFill } from "remotion";
import { Video } from "@remotion/media";
import type { Caption } from "@remotion/captions";
import { CaptionOverlay } from "./CaptionOverlay";

export const COMP_WIDTH = 1080;
export const COMP_HEIGHT = 1920;
export const COMP_FPS = 30;

export type VideoCompositionProps = {
  videoUrl: string;
  captions: Caption[];
  offsetX: number;
  startFrom?: number;
};

export function VideoComposition({
  videoUrl,
  captions,
  offsetX,
  startFrom = 0,
}: VideoCompositionProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Video layer: horizontal podcast cropped to 9:16 */}
      <AbsoluteFill>
        <Video
          src={videoUrl}
          startFrom={startFrom}
          style={{
            width: "177.78%", // 16/9 of container width to fill vertically
            height: "100%",
            objectFit: "cover",
            position: "absolute",
            left: "50%",
            transform: `translateX(calc(-50% + ${offsetX}px))`,
          }}
        />
      </AbsoluteFill>

      {/* Caption layer */}
      {captions.length > 0 && <CaptionOverlay captions={captions} />}
    </AbsoluteFill>
  );
}

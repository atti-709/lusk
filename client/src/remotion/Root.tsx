import { Composition } from "remotion";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
} from "../components/VideoComposition";
import type { VideoCompositionProps } from "../components/VideoComposition";

export function Root() {
  return (
    <Composition<VideoCompositionProps>
      id="LuskClip"
      component={VideoComposition}
      width={COMP_WIDTH}
      height={COMP_HEIGHT}
      fps={COMP_FPS}
      durationInFrames={1}
      defaultProps={{
        videoUrl: "",
        captions: [],
        offsetX: 0,
        startFrom: 0,
      }}
    />
  );
}

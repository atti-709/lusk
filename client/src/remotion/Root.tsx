import { Composition, staticFile } from "remotion";
import {
  VideoComposition,
  COMP_WIDTH,
  COMP_HEIGHT,
  COMP_FPS,
  OUTRO_OVERLAP_FRAMES,
} from "../components/VideoComposition";

const OUTRO_DURATION_FRAMES = 35;

export function Root() {
  return (
    <Composition
      id="LuskClip"
      component={VideoComposition}
      width={COMP_WIDTH}
      height={COMP_HEIGHT}
      fps={COMP_FPS}
      durationInFrames={240 + OUTRO_DURATION_FRAMES - OUTRO_OVERLAP_FRAMES}
      defaultProps={{
        videoUrl: "",
        captions: [],
        offsetX: 0,
        startFrom: 0,
        outroSrc: staticFile("outro.mp4"),
        outroDurationInFrames: OUTRO_DURATION_FRAMES,
      }}
    />
  );
}

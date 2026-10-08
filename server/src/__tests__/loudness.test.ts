import { describe, it, expect } from "vitest";
import { parseLoudnorm } from "../services/loudness.js";

describe("parseLoudnorm", () => {
  it("reads the measurement block at the end of ffmpeg's output", () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-32.34",\n\t"input_tp" : "-6.52",\n\t"input_lra" : "5.10",\n\t"input_thresh" : "-42.80",\n\t"output_i" : "-14.40",\n\t"target_offset" : "0.40"\n}\n`;
    expect(parseLoudnorm(`Input #0, mov,mp4 {not json}\n${stderr}`)).toMatchObject({ input_i: "-32.34", input_tp: "-6.52", target_offset: "0.40" });
  });

  it("gives up on silence and on output without a measurement", () => {
    expect(parseLoudnorm(`{\n"input_i" : "-inf",\n"input_tp" : "-inf"\n}`)).toBeNull();
    expect(parseLoudnorm("Error opening input")).toBeNull();
  });
});

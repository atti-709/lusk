import { open } from "node:fs/promises";

/** Where the sample data starts in a WAV file: after the "data" chunk header (ffmpeg writes a LIST chunk before it). */
async function dataOffset(fd: Awaited<ReturnType<typeof open>>): Promise<number> {
  const head = Buffer.alloc(4096);
  const { bytesRead } = await fd.read(head, 0, head.length, 0);
  let pos = 12; // RIFF, size, WAVE
  while (pos + 8 <= bytesRead) {
    const id = head.toString("ascii", pos, pos + 4);
    if (id === "data") return pos + 8;
    pos += 8 + head.readUInt32LE(pos + 4);
  }
  return 44;
}

/**
 * A 16 kHz mono s16 WAV file of seconds [t0, t1) of another one, as a Buffer — what the arbiter hears and sends,
 * cut without a process (the extracted audio.wav is what Whisper decoded, so it is the audio the words came from).
 */
export async function sliceWav(wavPath: string, t0: number, t1: number, rate = 16000): Promise<Buffer> {
  const fd = await open(wavPath, "r");
  try {
    const base = await dataOffset(fd);
    const size = (await fd.stat()).size;
    const from = Math.max(0, Math.round(t0 * rate)) * 2;
    const to = Math.min(size - base, Math.round(t1 * rate) * 2);
    const len = Math.max(0, to - from);
    const pcm = Buffer.alloc(len);
    await fd.read(pcm, 0, len, base + from);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + len, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(len, 40);
    return Buffer.concat([header, pcm]);
  } finally {
    await fd.close();
  }
}

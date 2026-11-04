// Cover → 512×512 WebP for the offline generators (soundscapes, stories).
import { readFile, rm } from "node:fs/promises";
import { runFfmpeg } from "./ffmpeg.js";
import { hasValidRiffSize } from "./soundscape.js";

/**
 * Writes `image` (PNG/JPEG) as a 512×512 WebP straight to `path`: the webp muxer fills in the
 * RIFF size only on a seekable output (through a pipe it stays 0 and Chromium refuses the image).
 * Verifies the RIFF size equals filesize − 8 afterwards; a bad file is deleted so the next run rebuilds it.
 */
export async function writeWebp512(image: Buffer, path: string): Promise<void> {
  await runFfmpeg(["-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1", "-vf", "scale=512:512:flags=lanczos", "-c:v", "libwebp", "-quality", "85", "-f", "webp", "-y", path], image);
  if (!hasValidRiffSize(await readFile(path))) {
    await rm(path, { force: true });
    throw new Error("cover WebP has an invalid RIFF size");
  }
}

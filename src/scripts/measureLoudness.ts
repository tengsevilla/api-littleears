// R3 check for a local audio file: `npm run audio:measure -- <file>`.
// Prints { integratedLufs, truePeakDb, lra, durationSec } as JSON. No env, DB, S3 or providers.
import { readFile } from "node:fs/promises";
import { measureLoudness } from "../lib/ffmpeg.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run audio:measure -- <file>");
  process.exit(2);
}

const { integratedLufs, truePeakDb, lra, durationSec } = await measureLoudness(await readFile(file));
console.log(JSON.stringify({ integratedLufs, truePeakDb, lra, durationSec }));

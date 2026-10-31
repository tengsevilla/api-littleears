// Thin ffmpeg-static runner (child_process.spawn, stdin → stdout). No fluent-ffmpeg (archived).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// ffmpeg-static is CommonJS (`module.exports = path`) with ESM-style typings, which nodenext
// resolves to the module namespace — require() gives the actual path string.
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

const DEFAULT_TIMEOUT_MS = 60_000;
const MASTER_TIMEOUT_MS = 180_000;

type FfmpegOutput = { stdout: Buffer; stderr: string };

function spawnFfmpeg(args: string[], input: Buffer, timeoutMs: number, logLevel: "error" | "info"): Promise<FfmpegOutput> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static binary not available for this platform"));
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", logLevel, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => (err += c.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`ffmpeg exited with ${code ?? "signal"}: ${err.slice(-500)}`));
    });
    proc.stdin.on("error", () => {}); // reported via close/exit code
    proc.stdin.end(input);
  });
}

export async function runFfmpeg(args: string[], input: Buffer, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
  return (await spawnFfmpeg(args, input, timeoutMs, "error")).stdout;
}

/** Runs ffmpeg at info log level and returns its stderr (stats, filter reports such as loudnorm's JSON). */
export async function runFfmpegReport(args: string[], input: Buffer, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return (await spawnFfmpeg(args, input, timeoutMs, "info")).stderr;
}

/** Re-encodes any single still image (e.g. JPEG) as PNG. */
export function toPng(image: Buffer): Promise<Buffer> {
  return runFfmpeg(["-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], image);
}

/**
 * Exact audio duration in seconds, by decoding the whole input (ffmpeg-static ships no ffprobe,
 * and a piped MP3's header duration is only an estimate). Reads the last `time=` stats line.
 */
export async function probeDurationSec(audio: Buffer): Promise<number> {
  const report = await runFfmpegReport(["-i", "pipe:0", "-map", "0:a:0", "-f", "null", "-"], audio);
  const times = [...report.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (!last) throw new Error("ffmpeg could not determine the audio duration");
  const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  if (!(seconds > 0)) throw new Error("audio has no duration");
  return seconds;
}

export type LoudnessReport = {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  durationSec: number;
  /** From the first audio stream's header line (ffmpeg-static ships no ffprobe). */
  sampleRateHz: number | null;
  bitrateKbps: number | null;
};

/**
 * Measures any audio file (EBU R128 via loudnorm's analysis pass, BS.1770 true peak) without
 * changing it — the R3 acceptance check for a mastered MP3. Throws on silent / unmeasurable input.
 */
export async function measureLoudness(audio: Buffer): Promise<LoudnessReport> {
  const report = await runFfmpegReport(["-i", "pipe:0", "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"], audio, MASTER_TIMEOUT_MS);
  const json = JSON.parse(report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1)) as Record<string, string>;
  const integratedLufs = Number(json.input_i);
  const truePeakDb = Number(json.input_tp);
  const lra = Number(json.input_lra);
  if (![integratedLufs, truePeakDb, lra].every(Number.isFinite)) throw new Error("audio has no measurable loudness");
  const stream = report.match(/Stream #0:\d+.*?: Audio: .*/)?.[0] ?? "";
  const hz = stream.match(/(\d+) Hz/)?.[1];
  const kbps = stream.match(/(\d+) kb\/s/)?.[1];
  return {
    integratedLufs,
    truePeakDb,
    lra,
    durationSec: await probeDurationSec(audio),
    sampleRateHz: hz ? Number(hz) : null,
    bitrateKbps: kbps ? Number(kbps) : null,
  };
}

export const FADE_OUT_SEC = 2;
/** Lullabies end with a longer "sleep fade" so the song drifts out instead of stopping. */
export const SLEEP_FADE_OUT_SEC = 6;

const sec = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * R3 master chain: fade in 1 s → loudnorm I=-16:TP=-1.5:LRA=11 → fade out over the last
 * `fadeOutSec` (2 s by default; capped at the duration for very short clips).
 */
export function masterFilter(durationSec: number, fadeOutSec = FADE_OUT_SEC): string {
  const d = Math.min(fadeOutSec, durationSec);
  const st = Math.max(0, durationSec - d);
  return `afade=t=in:d=1,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${sec(st)}:d=${sec(d)}`;
}

/**
 * Normalizes raw provider audio into the MP3 that is stored as `audio_key` (R3): probes the
 * duration, runs the master chain, encodes libmp3lame 192k. `-ar 44100` because loudnorm
 * upsamples internally to 192 kHz, which MP3 cannot carry.
 */
export async function masterAudio(raw: Buffer, fadeOutSec = FADE_OUT_SEC): Promise<{ audio: Buffer; durationMs: number }> {
  const duration = await probeDurationSec(raw);
  const audio = await runFfmpeg(
    ["-i", "pipe:0", "-map", "0:a:0", "-af", masterFilter(duration, fadeOutSec), "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"],
    raw,
    MASTER_TIMEOUT_MS,
  );
  const durationMs = Math.round((await probeDurationSec(audio)) * 1000);
  return { audio, durationMs };
}

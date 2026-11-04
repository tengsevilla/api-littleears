// Offline generator for the 8 looping background soundscapes (CLAUDE.md "Sounds").
// `npm run sounds:generate -- [--only a,b] [--force] [--no-cover] [--wav] [--mock]`
// No routes, DB or S3. Output: out/sounds/<slug>.mp3 (+ .webp, .wav) and manifest.json;
// raw ElevenLabs clips are cached in out/sounds/raw/ so re-runs (even --force) never re-buy them —
// delete a raw file to re-generate that take. --mock writes to out/sounds-mock/ instead, so mock
// clips can never end up in the real cache.
//
// Pipeline per sound: 3 × 30 s loop:true clips → decode 44.1 kHz stereo → each take is extended
// past 30 s by wrapping into its own start (it was generated to loop) so 3 takes are long enough
// for 90 s after the crossfades → join with acrossfade d=2 tri → closeLoop (2 s equal-power
// overlap-add of tail into head, exactly 3,969,000 frames) → −20 LUFS by constant gain + 4×
// oversampled peak limiter at −2.5 dBFS (see normalize() for why not loudnorm) → circular pad [last 1 s] + loop + [first 1 s] → libmp3lame 192k. No fades.
// The player loops [loopStartSample, loopEndSample) = [44100, 4013100) from manifest.json, so the
// MP3 codec's start/end boundaries are never on the seam. `--force --no-cover` rebuilds audio only
// from cached raw clips and leaves existing covers untouched.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeWebp512 } from "../lib/cover.js";
import { measureLoudness, runFfmpeg, runFfmpegReport } from "../lib/ffmpeg.js";
import {
  CHANNELS,
  LOOP_END_SAMPLE,
  LOOP_FRAMES,
  LOOP_PAD_FRAMES,
  LOOP_START_SAMPLE,
  SAMPLE_RATE,
  SEAM_FRAMES,
  SEAM_SEC,
  SOUNDSCAPES,
  closeLoop,
  padCircular,
  seamStats,
  type Soundscape,
} from "../lib/soundscape.js";
import type { ImageProvider, SoundEffectsProvider } from "../providers/types.js";

const CLIP_SEC = 30;
const TAKES = 3;
// Each take is cut to this length (wrapping into its own start) so that after two acrossfades the
// join still holds LOOP_FRAMES + SEAM_FRAMES: 3·E − 2·seam ≥ 90 s + seam → E ≥ 32 s; +0.5 s margin.
const TAKE_FRAMES = Math.ceil((LOOP_FRAMES + TAKES * SEAM_FRAMES) / TAKES) + SAMPLE_RATE / 2;
const LOUDNORM = "I=-20:TP=-2:LRA=11"; // measurement settings
const TARGET_I = -20;
// Oversampled sample-peak ceiling; 0.5 dB under the −2 dBTP target leaves room for MP3 overshoot.
const LIMIT_DB = -2.5;
const TIMEOUT_MS = 300_000;
const NORM_PAD_FRAMES = 3 * SAMPLE_RATE;
const DECODER_SLACK = 1_000; // frames; well inside the 1 s loop pad

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    force: { type: "boolean", default: false },
    "no-cover": { type: "boolean", default: false },
    wav: { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
  },
});

const root = fileURLToPath(new URL(`../../out/${args.mock ? "sounds-mock" : "sounds"}/`, import.meta.url));
const rawDir = `${root}raw/`;
const withCover = !args["no-cover"] && !args.mock;

// --- PCM helpers --------------------------------------------------------------------------------

const PCM_IN = ["-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "pipe:0"];
const PCM_OUT = ["-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1"];

const toFloat = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const toBytes = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);

/** Decodes the takes, extends each to TAKE_FRAMES by looping it once, joins with 2 s tri crossfades. */
async function joinTakes(paths: string[]): Promise<Float32Array> {
  const inputs = paths.flatMap((p) => ["-stream_loop", "1", "-i", p]);
  const prep = paths
    .map((_, i) => `[${i}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=stereo,atrim=end_sample=${TAKE_FRAMES}[t${i}]`)
    .join(";");
  let graph = prep;
  let last = "t0";
  for (let i = 1; i < paths.length; i++) {
    const label = i === paths.length - 1 ? "out" : `j${i}`;
    graph += `;[${last}][t${i}]acrossfade=d=${SEAM_SEC}:c1=tri:c2=tri[${label}]`;
    last = label;
  }
  const pcm = await runFfmpeg(["-nostdin", ...inputs, "-filter_complex", graph, "-map", "[out]", ...PCM_OUT], Buffer.alloc(0), TIMEOUT_MS);
  return toFloat(pcm);
}

type Measured = { i: number; tp: number; lra: number };

/** EBU R128 measurement of a PCM loop (loudnorm's analysis pass; the audio is not changed). */
async function measure(pcm: Float32Array): Promise<Measured> {
  const report = await runFfmpegReport([...PCM_IN, "-af", `loudnorm=${LOUDNORM}:print_format=json`, "-f", "null", "-"], toBytes(pcm), TIMEOUT_MS);
  const m = JSON.parse(report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1)) as Record<string, string>;
  const out = { i: Number(m.input_i), tp: Number(m.input_tp), lra: Number(m.input_lra) };
  if (!Number.isFinite(out.i)) throw new Error("soundscape has no measurable loudness");
  return out;
}

/**
 * Loudness to TARGET_I with a seam-safe chain: one constant gain + a 4×-oversampled peak limiter
 * (≈ true peak) at LIMIT_DB, run on a circularly padded copy and trimmed back.
 *
 * Not ffmpeg's loudnorm in its output pass: loudnorm falls back to dynamic mode whenever
 * LRA > target or linear gain would overshoot TP (7 of 8 sounds), and dynamic gain depends on a
 * long integrated history — rocket's gain drifted 0.22 → 0.38 over the file, so head and tail
 * got different gain and the seam stepped even with a 90 s circular pad. A constant gain cannot
 * break a seam, and the limiter's state depends only on the last few ms, which the 3 s circular
 * pad makes identical at both ends. Trade-off: LRA is not compressed to 11 (measured and printed).
 * Up to 4 passes re-aim the gain until within 0.1 LU (the limiter removes some loudness).
 */
async function normalize(pcm: Float32Array): Promise<{ pcm: Float32Array; before: Measured; after: Measured }> {
  const before = await measure(pcm);
  const padded = toBytes(padCircular(pcm, CHANNELS, NORM_PAD_FRAMES));
  const limit = 10 ** (LIMIT_DB / 20);
  let gainDb = TARGET_I - before.i;
  let out = pcm;
  let after = before;
  for (let pass = 0; pass < 4 && Math.abs(after.i - TARGET_I) > 0.1; pass++) {
    const chain =
      `volume=${gainDb.toFixed(3)}dB,aresample=${SAMPLE_RATE * 4},` +
      `alimiter=limit=${limit.toFixed(5)}:attack=5:release=50:level=false:latency=true,aresample=${SAMPLE_RATE}`;
    const full = toFloat(await runFfmpeg([...PCM_IN, "-af", chain, ...PCM_OUT], padded, TIMEOUT_MS));
    if (full.length !== padded.length / 4) {
      throw new Error(`normalize changed the length: ${full.length / CHANNELS} frames, expected ${padded.length / 4 / CHANNELS}`);
    }
    out = full.slice(NORM_PAD_FRAMES * CHANNELS, (NORM_PAD_FRAMES + LOOP_FRAMES) * CHANNELS);
    after = await measure(out);
    gainDb += TARGET_I - after.i;
  }
  return { pcm: out, before, after };
}

// Encoded straight to the file, not a pipe: the mp3 muxer can only write the LAME/Xing gapless
// header (encoder delay + padding) on a seekable output. Without it decoders add ~1,900 samples
// of silence and the loop gains a gap.
const encodeMp3 = (pcm: Float32Array, path: string) =>
  runFfmpeg([...PCM_IN, "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-f", "mp3", "-y", path], toBytes(pcm), TIMEOUT_MS);
const encodeWav = (pcm: Float32Array, path: string) => runFfmpeg([...PCM_IN, "-codec:a", "pcm_s16le", "-f", "wav", "-y", path], toBytes(pcm), TIMEOUT_MS);
/**
 * Stats of a finished MP3 as it will ship (decoded, so the length/seam check includes the encoder).
 * Decoded from the file path: from a pipe ffmpeg cannot apply the gapless end padding.
 */
async function statsOf(path: string) {
  const pcm = toFloat(await runFfmpeg(["-nostdin", "-i", path, ...PCM_OUT], Buffer.alloc(0), TIMEOUT_MS));
  const { integratedLufs, truePeakDb } = await measureLoudness(await readFile(path));
  const durationSamples = pcm.length / CHANNELS;
  if (durationSamples < LOOP_END_SAMPLE + DECODER_SLACK) {
    throw new Error(`decoded ${durationSamples} frames, expected ${LOOP_END_SAMPLE + LOOP_PAD_FRAMES}`);
  }
  // The seam as the player uses it, plus the same window shifted by ±DECODER_SLACK frames: a
  // decoder that trims encoder delay differently must still wrap smoothly (the pad is circular).
  const seam = seamStats(pcm, CHANNELS, LOOP_START_SAMPLE, LOOP_END_SAMPLE);
  const shifted = [-DECODER_SLACK, DECODER_SLACK].map((k) => seamStats(pcm, CHANNELS, LOOP_START_SAMPLE + k, LOOP_END_SAMPLE + k));
  return { durationSamples, lufs: integratedLufs, truePeakDb, seam, worstShiftedPercentile: Math.max(...shifted.map((x) => x.percentile)) };
}

// --- Providers ----------------------------------------------------------------------------------

async function makeProviders(): Promise<{ sfx: SoundEffectsProvider; image: ImageProvider | null }> {
  if (args.mock) {
    const { MockSoundEffectsProvider } = await import("../providers/mock/index.js");
    return { sfx: new MockSoundEffectsProvider(), image: null };
  }
  // Imported lazily so --mock runs need no credentials.
  const { env } = await import("../lib/env.js");
  const { ElevenLabsSoundEffectsProvider } = await import("../providers/elevenlabs/soundEffects.js");
  const need = (v: string | undefined, key: string) => {
    if (!v) throw new Error(`${key} is required (or pass --mock)`);
    return v;
  };
  const sfx = new ElevenLabsSoundEffectsProvider({ apiKey: need(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY"), model: env.ELEVENLABS_SFX_MODEL });
  if (!withCover) return { sfx, image: null };
  const { GeminiImageProvider } = await import("../providers/gemini/image.js");
  const { StyledImageProvider } = await import("../providers/image.js");
  const image = new StyledImageProvider(
    new GeminiImageProvider({ apiKey: need(env.GEMINI_API_KEY, "GEMINI_API_KEY"), model: need(env.GEMINI_IMAGE_MODEL, "GEMINI_IMAGE_MODEL") }),
  );
  return { sfx, image };
}

// --- Main ---------------------------------------------------------------------------------------

const paths = (slug: string) => ({ mp3: `${root}${slug}.mp3`, wav: `${root}${slug}.wav`, webp: `${root}${slug}.webp` });

function isDone(slug: string): boolean {
  const p = paths(slug);
  return existsSync(p.mp3) && (!withCover || existsSync(p.webp)) && (!args.wav || existsSync(p.wav));
}

async function build(sound: Soundscape, sfx: SoundEffectsProvider, image: ImageProvider | null) {
  const raws: string[] = [];
  for (let n = 1; n <= TAKES; n++) {
    const raw = `${rawDir}${sound.slug}-${n}.mp3`;
    if (!existsSync(raw)) {
      console.log(`  generating take ${n}/${TAKES}`);
      await writeFile(raw, await sfx.generate({ text: sound.prompts[n - 1]!, durationSec: CLIP_SEC, loop: true }));
    }
    raws.push(raw);
  }
  const looped = closeLoop(await joinTakes(raws), CHANNELS, LOOP_FRAMES, SEAM_FRAMES);
  const { pcm: final, before, after } = await normalize(looped);
  console.log(
    `  level: in I=${before.i.toFixed(2)} TP=${before.tp.toFixed(2)} LRA=${before.lra.toFixed(1)} → ` +
      `out I=${after.i.toFixed(2)} TP=${after.tp.toFixed(2)} LRA=${after.lra.toFixed(1)}`,
  );
  const p = paths(sound.slug);
  const pcmSeam = seamStats(final, CHANNELS, 0, LOOP_FRAMES);
  console.log(`  pcm loop: frames=${final.length / CHANNELS} seamStep=${pcmSeam.seamStep.toFixed(5)} (p${pcmSeam.percentile.toFixed(1)}, max step ${pcmSeam.maxStep.toFixed(5)})`);
  // Ship [last 1 s] + loop + [first 1 s]: the codec's edges land in the pad, never on the seam.
  const shipped = padCircular(final, CHANNELS, LOOP_PAD_FRAMES);
  await encodeMp3(shipped, p.mp3);
  if (args.wav) await encodeWav(shipped, p.wav);
  if (image) await writeWebp512(await image.generate({ prompt: sound.cover }), p.webp);
}

async function main() {
  const only = args.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = only?.filter((s) => !SOUNDSCAPES.some((x) => x.slug === s)) ?? [];
  if (unknown.length) throw new Error(`unknown slug(s): ${unknown.join(", ")}`);
  const selected = SOUNDSCAPES.filter((s) => !only || only.includes(s.slug));

  await mkdir(rawDir, { recursive: true });
  const { sfx, image } = await makeProviders();
  let failed = 0;
  const stats = new Map<string, Awaited<ReturnType<typeof statsOf>>>();

  for (const sound of selected) {
    if (!args.force && isDone(sound.slug)) {
      console.log(`${sound.slug}: outputs exist, skipped (--force to rebuild)`);
      continue;
    }
    console.log(`${sound.slug}: building`);
    try {
      await build(sound, sfx, image);
      const s = await statsOf(paths(sound.slug).mp3);
      stats.set(sound.slug, s);
      console.log(
        `${sound.slug}: samples=${s.durationSamples} (${(s.durationSamples / SAMPLE_RATE).toFixed(3)} s) ` +
          `loop=[${LOOP_START_SAMPLE}, ${LOOP_END_SAMPLE}) lufs=${s.lufs.toFixed(2)} tp=${s.truePeakDb.toFixed(2)} ` +
          `seamStep=${s.seam.seamStep.toFixed(5)} (p${s.seam.percentile.toFixed(1)} of steps, max ${s.seam.maxStep.toFixed(5)}, mean ${s.seam.meanStep.toFixed(5)}) ` +
          `±${DECODER_SLACK} offset worst p${s.worstShiftedPercentile.toFixed(1)}`,
      );
    } catch (err) {
      failed++;
      console.error(`${sound.slug}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Manifest covers every sound whose MP3 exists, measured from the file itself.
  const manifest = [];
  for (const sound of SOUNDSCAPES) {
    const mp3 = paths(sound.slug).mp3;
    if (!existsSync(mp3)) continue;
    const s = stats.get(sound.slug) ?? (await statsOf(mp3));
    manifest.push({
      slug: sound.slug,
      title: sound.title,
      durationSamples: s.durationSamples,
      sampleRate: SAMPLE_RATE,
      loopStartSample: LOOP_START_SAMPLE,
      loopEndSample: LOOP_END_SAMPLE,
      lufs: Math.round(s.lufs * 100) / 100,
    });
  }
  await writeFile(`${root}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: ${manifest.length} sound(s) → ${root}manifest.json`);
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("sounds:generate failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

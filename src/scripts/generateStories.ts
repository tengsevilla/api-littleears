// Offline generator for the 90 s POV "story sounds" (ASMR-style scenes for kids). See CLAUDE.md "Sounds".
// `npm run stories:generate -- [--only cars,farm] [--remix] [--no-cover] [--mock]`
// No routes, DB or S3. Output: out/stories/<slug>.mp3 + <slug>.webp + manifest.json.
//
// Raw cache: every vendor result lives in out/stories/raw/<slug>/<file>.mp3 with a <file>.key
// sidecar = sha256 of exactly what the vendor was sent (model + prompt/lines; see cacheKey). A clip
// is re-bought only when its key changes, so editing one line re-buys only that dialogue clip, and
// timing/gain/radio/fade edits re-buy nothing. Identical requests inside a story (same key) are
// bought once and copied. --remix never calls a vendor and fails if any clip is missing or stale.
// --mock uses tone fixtures and writes to out/stories-mock/, so mock clips never enter the real cache.
//
// Pipeline per story: clips → one WAV stem per sfx track (spot: trimmed clip; bed: ≤30 s loop
// clips joined with 2 s crossfades) and per dialogue clip (radio: 300–3400 Hz, soft clip + light
// acrusher, mono, ~80 ms synthesized squelch before and after) → timeline mix (adelay by exact
// sample, per-track gain, sfx ducked 6 dB under speech, amix normalize=0, exactly 3,969,000
// frames at 44.1 kHz stereo) → two-pass loudnorm I=-16:TP=-1.5:LRA=11 → afade out at 89 s for 1 s
// (no fade-in) → libmp3lame 192k written straight to the file (seekable output → gapless header).
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeWebp512 } from "../lib/cover.js";
import { measureLoudness, probeDurationSec, runFfmpeg, runFfmpegReport } from "../lib/ffmpeg.js";
import { CHANNELS, SAMPLE_RATE } from "../lib/soundscape.js";
import { STORIES, VOICES } from "../lib/storyData.js";
import {
  STORY_FRAMES,
  cacheKey,
  dialogueClip,
  dialogueStemArgs,
  liftFor,
  longestQuietRun,
  longestRmsGap,
  masterChain,
  mixArgs,
  parseEbur128,
  sfxClips,
  sfxStemArgs,
  storyClips,
  validateStory,
  windowLoudness,
  type Clip,
  type Interval,
  type Lift,
  type LoudnormMeasure,
  type Stem,
  type Story,
} from "../lib/stories.js";
import { chunkDialogue } from "../providers/elevenlabs/dialogue.js";
import { failureText } from "../providers/errors.js";
import { STYLE_PROMPT } from "../providers/image.js";
import type { DialogueProvider, ImageProvider, SoundEffectsProvider } from "../providers/types.js";

const TIMEOUT_MS = 300_000;
const QUIET_LUFS = -30;
const RMS_GAP_DBFS = -45;
const MAX_RMS_GAP_SEC = 1.5;

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    remix: { type: "boolean", default: false },
    "no-cover": { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
  },
});

const root = fileURLToPath(new URL(`../../out/${args.mock ? "stories-mock" : "stories"}/`, import.meta.url));
const withCover = !args["no-cover"];
const counts = { made: 0, cached: 0, copied: 0 };

type Vendors = { sfx: SoundEffectsProvider; dialogue: DialogueProvider; image: ImageProvider | null };
type Models = { sfx: string; dialogue: string };

// --- Providers ----------------------------------------------------------------------------------

async function makeVendors(): Promise<{ vendors: Vendors | null; models: Models }> {
  if (args.mock) {
    const { MockDialogueProvider, MockImageProvider, MockSoundEffectsProvider } = await import("../providers/mock/index.js");
    const vendors = { sfx: new MockSoundEffectsProvider(), dialogue: new MockDialogueProvider(), image: new MockImageProvider() };
    return { vendors: args.remix ? null : vendors, models: { sfx: "mock", dialogue: "mock" } };
  }
  // Imported lazily so --mock runs need no credentials.
  const { env } = await import("../lib/env.js");
  const models = { sfx: env.ELEVENLABS_SFX_MODEL, dialogue: env.ELEVENLABS_DIALOGUE_MODEL };
  if (args.remix) return { vendors: null, models };
  const need = (v: string | undefined, key: string) => {
    if (!v) throw new Error(`${key} is required (or pass --mock / --remix)`);
    return v;
  };
  const apiKey = need(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY");
  const { ElevenLabsSoundEffectsProvider } = await import("../providers/elevenlabs/soundEffects.js");
  const { ElevenLabsDialogueProvider } = await import("../providers/elevenlabs/dialogue.js");
  let image: ImageProvider | null = null;
  if (withCover) {
    const { GeminiImageProvider } = await import("../providers/gemini/image.js");
    const { StyledImageProvider } = await import("../providers/image.js");
    image = new StyledImageProvider(new GeminiImageProvider({ apiKey: need(env.GEMINI_API_KEY, "GEMINI_API_KEY"), model: need(env.GEMINI_IMAGE_MODEL, "GEMINI_IMAGE_MODEL") }));
  }
  return {
    vendors: { sfx: new ElevenLabsSoundEffectsProvider({ apiKey, model: models.sfx }), dialogue: new ElevenLabsDialogueProvider({ apiKey, model: models.dialogue }), image },
    models,
  };
}

// --- Raw cache ----------------------------------------------------------------------------------

const rawDir = (slug: string) => `${root}raw/${slug}/`;
const readKey = async (path: string) => (existsSync(path) ? (await readFile(path, "utf8")).trim() : null);

/** Cached file for `key` in `dir` under any name (identical request bought for another id). */
async function findByKey(dir: string, key: string, ext: string): Promise<string | null> {
  for (const f of await readdir(dir)) {
    if (f.endsWith(".key") && (await readKey(`${dir}${f}`)) === key) {
      const media = `${dir}${f.slice(0, -4)}${ext}`;
      if (existsSync(media)) return media;
    }
  }
  return null;
}

/** Path of the cached result for `key`, buying it with `buy` only when nothing matches. */
async function cached(dir: string, file: string, ext: string, key: string, buy: (() => Promise<Buffer>) | null): Promise<string> {
  const path = `${dir}${file}${ext}`;
  const keyPath = `${dir}${file}.key`;
  if (existsSync(path) && (await readKey(keyPath)) === key) {
    counts.cached++;
    return path;
  }
  const same = await findByKey(dir, key, ext);
  if (same) {
    await copyFile(same, path);
    await writeFile(keyPath, `${key}\n`);
    counts.copied++;
    return path;
  }
  if (!buy) throw new Error(`--remix: ${file}${ext} is missing or out of date in ${dir}`);
  const data = await buy();
  await writeFile(path, data);
  await writeFile(keyPath, `${key}\n`);
  counts.made++;
  return path;
}

function clipBuyer(clip: Clip, vendors: Vendors | null): (() => Promise<Buffer>) | null {
  if (!vendors) return null;
  return clip.kind === "sfx"
    ? () => vendors.sfx.generate({ text: clip.text, durationSec: clip.durationSec, loop: clip.loop })
    : () => vendors.dialogue.generate({ lines: clip.lines });
}

/** In --remix, reports every missing/stale clip at once before failing. */
async function missingClips(story: Story, clips: Clip[]): Promise<string[]> {
  const dir = rawDir(story.slug);
  const missing: string[] = [];
  for (const c of clips) {
    const ok = existsSync(`${dir}${c.file}.mp3`) && (await readKey(`${dir}${c.file}.key`)) === c.key;
    if (!ok && !(await findByKey(dir, c.key, ".mp3"))) missing.push(c.file);
  }
  return missing;
}

// --- Plan ---------------------------------------------------------------------------------------

function plan(story: Story, clips: Clip[]): string {
  const unique = new Map(clips.map((c) => [c.key, c]));
  const sfx = [...unique.values()].filter((c) => c.kind === "sfx");
  const dlg = [...unique.values()].filter((c) => c.kind === "dialogue");
  const sfxSec = sfx.reduce((a, c) => a + c.durationSec, 0);
  const calls = dlg.reduce((a, c) => a + chunkDialogue(c.lines).length, 0);
  const chars = dlg.reduce((a, c) => a + c.lines.reduce((n, l) => n + l.text.length, 0), 0);
  return `plan (if nothing were cached): ${sfx.length} sfx clips / ${sfxSec.toFixed(1)} s, ${calls} dialogue calls / ${chars} chars, ${withCover ? 1 : 0} image (${story.sfx.length} sfx tracks, ${story.dialogue.length} dialogue clips)`;
}

// --- Clip level ---------------------------------------------------------------------------------

/** Integrated loudness and true peak of one raw clip (loudnorm analysis; −Infinity when silent). */
async function clipLoudness(path: string): Promise<{ lufs: number; truePeakDb: number }> {
  const report = await runFfmpegReport(["-nostdin", "-i", path, "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"], Buffer.alloc(0), TIMEOUT_MS);
  const m = JSON.parse(report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1)) as Record<string, string>;
  const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : -Infinity);
  return { lufs: num(m.input_i), truePeakDb: num(m.input_tp) };
}

// --- Build --------------------------------------------------------------------------------------

const toFloatLen = (b: Buffer) => b.byteLength / 4;

async function build(story: Story, vendors: Vendors | null, models: Models) {
  const raw = rawDir(story.slug);
  const work = `${root}work/${story.slug}/`;
  await mkdir(raw, { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const clips = storyClips(story, VOICES, models);
  console.log(`  ${plan(story, clips)}`);
  if (!vendors) {
    const missing = await missingClips(story, clips);
    if (missing.length) throw new Error(`--remix: missing or out-of-date clips: ${missing.join(", ")}`);
  }

  // Stems. Sfx tracks are ducked under every dialogue interval.
  const stems: Stem[] = [];
  const lifted: string[] = [];
  for (const s of story.sfx) {
    const takes = [];
    const lifts: (Lift | null)[] = [];
    for (const c of sfxClips(s, models.sfx)) {
      const path = await cached(raw, c.file, ".mp3", c.key, clipBuyer(c, vendors));
      takes.push(path);
      // Level conditioning happens here, in the mix stage, so --remix applies it offline.
      const m = await clipLoudness(path);
      const lift = liftFor(m.lufs, m.truePeakDb, s.untilSec !== undefined);
      lifts.push(lift);
      if (lift) lifted.push(`${c.file} +${lift.gainDb.toFixed(1)} dB (${m.lufs.toFixed(1)} LUFS → ${(m.lufs + lift.gainDb).toFixed(1)}${lift.limit ? ", limited" : ""})`);
    }
    const out = `${work}sfx-${s.id}.wav`;
    await runFfmpeg(sfxStemArgs(s, takes, out, lifts), Buffer.alloc(0), TIMEOUT_MS);
    stems.push({ path: out, atSec: s.atSec, gainDb: s.gainDb, duck: true });
  }
  console.log(lifted.length ? `  lifted ${lifted.length} quiet clip(s): ${lifted.join("; ")}` : "  lifted: none (all clips at or above their floor)");
  const speech: Interval[] = [];
  for (const d of story.dialogue) {
    const c = dialogueClip(d, VOICES, models.dialogue);
    const clipPath = await cached(raw, c.file, ".mp3", c.key, clipBuyer(c, vendors));
    const out = `${work}dlg-${d.id}.wav`;
    await runFfmpeg(dialogueStemArgs(d.radio, clipPath, out), Buffer.alloc(0), TIMEOUT_MS);
    const len = await probeDurationSec(await readFile(out));
    const end = d.atSec + len;
    const overlap = speech.find((i) => d.atSec < i.end && end > i.start);
    if (overlap) console.warn(`  warning: ${d.id} (${d.atSec}–${end.toFixed(2)} s) overlaps other dialogue (${overlap.start}–${overlap.end.toFixed(2)} s)`);
    if (end > 89) console.warn(`  warning: ${d.id} ends at ${end.toFixed(2)} s, inside the final fade`);
    console.log(`  ${d.id}: ${d.atSec.toFixed(1)}–${end.toFixed(2)} s${d.radio ? " (radio)" : ""}`);
    speech.push({ start: d.atSec, end });
    stems.push({ path: out, atSec: d.atSec, gainDb: d.gainDb, duck: false });
  }

  const mix = `${work}mix.wav`;
  await runFfmpeg(mixArgs(stems, speech, mix), Buffer.alloc(0), TIMEOUT_MS);

  // Two-pass loudnorm: measure the mix, then apply linearly with the measurements.
  const report = await runFfmpegReport(["-nostdin", "-i", mix, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], Buffer.alloc(0), TIMEOUT_MS);
  const measured = JSON.parse(report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1)) as LoudnormMeasure;
  if (!Number.isFinite(Number(measured.input_i))) throw new Error("mix has no measurable loudness");
  await runFfmpeg(
    ["-nostdin", "-i", mix, "-af", masterChain(measured), "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "-y", `${root}${story.slug}.mp3`],
    Buffer.alloc(0),
    TIMEOUT_MS,
  );

  if (withCover) {
    const prompt = `${STYLE_PROMPT}\n\n${story.cover}`; // what StyledImageProvider sends
    const image = vendors?.image ?? null;
    const png = await cached(raw, "cover", ".png", cacheKey({ kind: "cover", prompt }), image ? () => image.generate({ prompt: story.cover }) : null);
    await writeWebp512(await readFile(png), `${root}${story.slug}.webp`);
  }
  await rm(work, { recursive: true, force: true });
  await rmdir(`${root}work`).catch(() => {}); // only when no other story's work dir is left
}

// --- Stats --------------------------------------------------------------------------------------

/** Measured from the finished file (decoded from the path so the gapless header is applied). */
async function statsOf(path: string) {
  const pcm = await runFfmpeg(["-nostdin", "-i", path, "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1"], Buffer.alloc(0), TIMEOUT_MS);
  const { integratedLufs, truePeakDb } = await measureLoudness(await readFile(path));
  const log = await runFfmpegReport(["-nostdin", "-i", path, "-af", "ebur128", "-f", "null", "-"], Buffer.alloc(0), TIMEOUT_MS);
  const points = parseEbur128(log);
  const windows = windowLoudness(points);
  return {
    durationSamples: toFloatLen(pcm) / CHANNELS,
    lufs: integratedLufs,
    truePeakDb,
    windows,
    quietPct: (windows.filter((w) => w < QUIET_LUFS).length / windows.length) * 100,
    longestGapSec: longestQuietRun(points),
    longestRmsGapSec: longestRmsGap(new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), CHANNELS, SAMPLE_RATE, RMS_GAP_DBFS),
  };
}

function printStats(slug: string, s: Awaited<ReturnType<typeof statsOf>>) {
  console.log(
    `${slug}: samples=${s.durationSamples} (${(s.durationSamples / SAMPLE_RATE).toFixed(3)} s, expected ${STORY_FRAMES}) ` +
      `I=${s.lufs.toFixed(2)} LUFS TP=${s.truePeakDb.toFixed(2)} dBTP`,
  );
  const fmt = (w: number) => (Number.isFinite(w) ? w.toFixed(1) : "-inf");
  console.log(`  momentary loudness, 5 s windows (LUFS): ${s.windows.map((w, i) => `${i * 5}s ${fmt(w)}`).join(" | ")}`);
  console.log(`  windows quieter than ${QUIET_LUFS} LUFS: ${s.quietPct.toFixed(1)}%; longest stretch under -40 LUFS momentary: ${s.longestGapSec.toFixed(1)} s`);
  console.log(`  longest stretch with 100 ms RMS below ${RMS_GAP_DBFS} dBFS: ${s.longestRmsGapSec.toFixed(1)} s`);
  if (s.longestRmsGapSec > MAX_RMS_GAP_SEC) console.warn(`  warning: ${slug} has a ${s.longestRmsGapSec.toFixed(1)} s near-silent stretch (> ${MAX_RMS_GAP_SEC} s)`);
}

// --- Main ---------------------------------------------------------------------------------------

async function main() {
  const only = args.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = only?.filter((s) => !STORIES.some((x) => x.slug === s)) ?? [];
  if (unknown.length) throw new Error(`unknown slug(s): ${unknown.join(", ")}`);
  const selected = STORIES.filter((s) => !only || only.includes(s.slug));

  // Validate everything (data + vendor text limits) before buying anything.
  for (const story of selected) {
    const errors = validateStory(story, VOICES);
    for (const d of story.dialogue) {
      try {
        chunkDialogue(d.lines.map((l) => ({ text: l.text, voiceId: VOICES[l.voice].id })));
      } catch (err) {
        errors.push(`${d.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length) throw new Error(`${story.slug}: invalid story data:\n  ${errors.join("\n  ")}`);
  }

  await mkdir(root, { recursive: true });
  const { vendors, models } = await makeVendors();
  let failed = 0;
  const stats = new Map<string, Awaited<ReturnType<typeof statsOf>>>();
  for (const story of selected) {
    console.log(`${story.slug}: building${args.remix ? " (remix, no vendor calls)" : ""}`);
    try {
      await build(story, vendors, models);
      const s = await statsOf(`${root}${story.slug}.mp3`);
      stats.set(story.slug, s);
      printStats(story.slug, s);
    } catch (err) {
      failed++;
      console.error(`${story.slug}: FAILED — ${failureText(err)}`);
    }
  }
  console.log(`vendor calls: ${counts.made} made, ${counts.cached + counts.copied} cached (${counts.copied} reused from an identical request)`);

  const manifest = [];
  for (const story of STORIES) {
    const mp3 = `${root}${story.slug}.mp3`;
    if (!existsSync(mp3)) continue;
    const s = stats.get(story.slug) ?? (await statsOf(mp3));
    manifest.push({
      slug: story.slug,
      title: story.title,
      src: `${story.slug}.mp3`,
      cover: existsSync(`${root}${story.slug}.webp`) ? `${story.slug}.webp` : null,
      durationSamples: s.durationSamples,
      sampleRate: SAMPLE_RATE,
      lufs: Math.round(s.lufs * 100) / 100,
      truePeakDb: Math.round(s.truePeakDb * 100) / 100,
    });
  }
  await writeFile(`${root}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest: ${manifest.length} story(ies) → ${root}manifest.json`);
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("stories:generate failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

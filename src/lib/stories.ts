// Story-sound model, cache keys and the ffmpeg graph builders for the offline story generator
// (src/scripts/generateStories.ts). Pure: no env, DB, S3, providers or file I/O.
import { createHash } from "node:crypto";
import { SAMPLE_RATE } from "./soundscape.js";

export const STORY_SEC = 90;
export const STORY_FRAMES = STORY_SEC * SAMPLE_RATE; // 3,969,000
export const MAX_SFX_SEC = 30;
export const MIN_SFX_SEC = 0.5;
/** Crossfade between consecutive ≤30 s clips of one bed. */
export const BED_XFADE_SEC = 2;
export const DUCK_DB = -6;
export const DUCK_RAMP_SEC = 0.25;
export const SQUELCH_SEC = 0.08;
export const FINAL_FADE = { st: 89, d: 1 } as const;

/** Premade ElevenLabs voices; ids + names are in src/lib/storyData.ts. */
export type VoiceRole = "engineer" | "hero" | "announcer" | "conductor";

export type StorySfx = {
  id: string;
  atSec: number;
  /** Length of one generated clip (0.5–30 s, the vendor limit). */
  durationSec: number;
  prompt: string;
  gainDb: number;
  loop?: boolean;
  /**
   * Bed: repeat the clip(s) from atSec to untilSec, joined with BED_XFADE_SEC crossfades.
   * Requires loop:true. Omitted = a one-shot spot effect of durationSec.
   */
  untilSec?: number;
  /** Bed only: number of different generations to alternate (default 1), each a vendor call. */
  takes?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

export type StoryDialogue = {
  id: string;
  atSec: number;
  lines: { voice: VoiceRole; text: string }[];
  /** Team radio: band-limited, lightly crushed, mono, with a squelch before and after. */
  radio: boolean;
  gainDb: number;
};

export type Story = { slug: string; title: string; sfx: StorySfx[]; dialogue: StoryDialogue[]; cover: string };

// --- Validation ---------------------------------------------------------------------------------

/** Returns every problem in the story data (empty = valid). Vendor text limits are checked by the provider. */
export function validateStory(story: Story, voices: Record<VoiceRole, unknown>): string[] {
  const errors: string[] = [];
  const ids = [...story.sfx.map((s) => s.id), ...story.dialogue.map((d) => d.id), "cover"];
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate ids: ${[...new Set(dup)].join(", ")}`);
  for (const id of ids) if (!/^[a-z0-9-]+$/.test(id)) errors.push(`${id}: ids must be lowercase a-z, 0-9, -`);
  for (const s of story.sfx) {
    if (!(s.durationSec >= MIN_SFX_SEC && s.durationSec <= MAX_SFX_SEC)) errors.push(`${s.id}: durationSec must be ${MIN_SFX_SEC}–${MAX_SFX_SEC}`);
    if (!(s.atSec >= 0 && s.atSec < STORY_SEC)) errors.push(`${s.id}: atSec outside 0–${STORY_SEC}`);
    if (s.untilSec !== undefined) {
      if (!s.loop) errors.push(`${s.id}: a bed (untilSec) needs loop:true`);
      if (!(s.untilSec > s.atSec && s.untilSec <= STORY_SEC)) errors.push(`${s.id}: untilSec must be after atSec and ≤ ${STORY_SEC}`);
    } else if (s.takes !== undefined) errors.push(`${s.id}: takes only applies to beds`);
    if (s.takes !== undefined && !(Number.isInteger(s.takes) && s.takes >= 1)) errors.push(`${s.id}: takes must be a positive integer`);
  }
  for (const d of story.dialogue) {
    if (!(d.atSec >= 0 && d.atSec < STORY_SEC)) errors.push(`${d.id}: atSec outside 0–${STORY_SEC}`);
    if (d.lines.length === 0) errors.push(`${d.id}: no lines`);
    for (const l of d.lines) if (!(l.voice in voices)) errors.push(`${d.id}: unknown voice ${l.voice}`);
  }
  return errors;
}

// --- Clips + cache keys -------------------------------------------------------------------------

export type SfxClip = { kind: "sfx"; file: string; key: string; text: string; durationSec: number; loop: boolean };
export type DialogueClip = { kind: "dialogue"; file: string; key: string; lines: { text: string; voiceId: string }[] };
export type Clip = SfxClip | DialogueClip;

/**
 * Cache key of one vendor result: sha256 over exactly what the vendor receives (model + request).
 * Mixing-only fields (atSec, gainDb, fades, radio) are not in it, so changing them never re-buys a clip.
 */
export function cacheKey(payload: { kind: "sfx"; model: string; text: string; durationSec: number; loop: boolean; take: number } | { kind: "dialogue"; model: string; lines: { text: string; voiceId: string }[] } | { kind: "cover"; prompt: string }): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export const takeFile = (id: string, take: number) => (take === 1 ? id : `${id}-t${take}`);

export function sfxClips(s: StorySfx, model: string): SfxClip[] {
  const loop = s.loop ?? false;
  return Array.from({ length: s.untilSec === undefined ? 1 : (s.takes ?? 1) }, (_, i) => ({
    kind: "sfx" as const,
    file: takeFile(s.id, i + 1),
    key: cacheKey({ kind: "sfx", model, text: s.prompt, durationSec: s.durationSec, loop, take: i + 1 }),
    text: s.prompt,
    durationSec: s.durationSec,
    loop,
  }));
}

export function dialogueClip(d: StoryDialogue, voices: Record<VoiceRole, { id: string }>, model: string): DialogueClip {
  const lines = d.lines.map((l) => ({ text: l.text, voiceId: voices[l.voice].id }));
  return { kind: "dialogue", file: d.id, key: cacheKey({ kind: "dialogue", model, lines }), lines };
}

export function storyClips(story: Story, voices: Record<VoiceRole, { id: string }>, models: { sfx: string; dialogue: string }): Clip[] {
  return [...story.sfx.flatMap((s) => sfxClips(s, models.sfx)), ...story.dialogue.map((d) => dialogueClip(d, voices, models.dialogue))];
}

// --- ffmpeg stems -------------------------------------------------------------------------------

const AFORMAT = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
const WAV_OUT = ["-c:a", "pcm_f32le", "-f", "wav", "-y"];
const n3 = (n: number) => String(Math.round(n * 1000) / 1000);

/** Fade-in at the start and fade-out at the end, without needing the clip's length (reverse trick). */
function fades(inSec: number, outSec: number): string {
  const f: string[] = [];
  if (inSec > 0) f.push(`afade=t=in:d=${n3(inSec)}`);
  if (outSec > 0) f.push(`areverse,afade=t=in:d=${n3(outSec)},areverse`);
  return f.length ? `,${f.join(",")}` : "";
}

/** Number of ≤durationSec clips needed to fill [atSec, untilSec) with `xfade` overlaps, plus one spare for short vendor clips. */
export function bedSegments(s: StorySfx): number {
  const span = (s.untilSec ?? s.atSec + s.durationSec) - s.atSec;
  if (span <= s.durationSec) return 1;
  const x = Math.min(BED_XFADE_SEC, s.durationSec / 3);
  return Math.ceil((span - x) / (s.durationSec - x)) + 1;
}

// --- Level conditioning ------------------------------------------------------------------------
// Some vendor clips come back very quiet (farm beds at −45…−51 LUFS), so the track's gainDb could
// never bring them up into the scene. Each raw take is measured and lifted to a floor before
// gainDb; loud clips are never lowered, so an approved balance (cars) is untouched.
export const BED_FLOOR_LUFS = -24;
export const SPOT_FLOOR_LUFS = -22;
export const MAX_LIFT_DB = 30;
/** Peak ceiling for a lifted clip (only applied when the lift would push the true peak above it). */
export const LIFT_CEILING_DB = -1;

export type Lift = { gainDb: number; limit: boolean };

/** Constant lift for one raw clip from its integrated loudness / true peak; null = leave as is. */
export function liftFor(lufs: number, truePeakDb: number, isBed: boolean): Lift | null {
  const floor = isBed ? BED_FLOOR_LUFS : SPOT_FLOOR_LUFS;
  const level = Number.isFinite(lufs) ? lufs : -Infinity; // silent / unmeasurable → maximum lift
  if (!(level < floor)) return null;
  const gainDb = Math.round(Math.min(floor - level, MAX_LIFT_DB) * 100) / 100;
  const peak = Number.isFinite(truePeakDb) ? truePeakDb : -Infinity;
  return { gainDb, limit: peak + gainDb > LIFT_CEILING_DB };
}

function liftFilter(l: Lift | null | undefined): string {
  if (!l) return "";
  const limiter = l.limit ? `,alimiter=limit=${(10 ** (LIFT_CEILING_DB / 20)).toFixed(5)}:attack=5:release=50:level=false` : "";
  return `,volume=${l.gainDb}dB${limiter}`;
}

/** Longest run (seconds) of `blockSec` blocks whose RMS (all channels) is below `thresholdDb` dBFS. */
export function longestRmsGap(pcm: Float32Array, channels: number, rate: number, thresholdDb = -45, blockSec = 0.1): number {
  const block = Math.round(rate * blockSec) * channels;
  const threshold = 10 ** (thresholdDb / 20);
  let best = 0;
  let run = 0;
  for (let start = 0; start + block <= pcm.length; start += block) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += pcm[i]! * pcm[i]!;
    run = Math.sqrt(sum / block) < threshold ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return Math.round(best * blockSec * 10) / 10;
}

/**
 * One sfx track → a WAV stem starting at its own t=0. Spot: the clip trimmed to durationSec.
 * Bed: takes alternated (take1, take2, …, take1, …) and joined with tri crossfades, trimmed to
 * untilSec − atSec. `lifts[take]` (see liftFor) is applied to each take before anything else. Default fades: none in (so a t=0 bed hits at once), 0.2 s out (no click).
 */
export function sfxStemArgs(s: StorySfx, takePaths: string[], outPath: string, lifts: (Lift | null)[] = []): string[] {
  const fade = fades(s.fadeInSec ?? 0, s.fadeOutSec ?? 0.2);
  const lift = (take: number) => liftFilter(lifts[take]);
  if (s.untilSec === undefined) {
    return ["-nostdin", "-i", takePaths[0]!, "-filter_complex", `[0:a]${AFORMAT}${lift(0)},atrim=duration=${n3(s.durationSec)}${fade}[out]`, "-map", "[out]", ...WAV_OUT, outPath];
  }
  const span = s.untilSec - s.atSec;
  const n = bedSegments(s);
  const x = Math.min(BED_XFADE_SEC, s.durationSec / 3);
  const inputs = Array.from({ length: n }, (_, i) => ["-i", takePaths[i % takePaths.length]!]).flat();
  let graph = Array.from({ length: n }, (_, i) => `[${i}:a]${AFORMAT}${lift(i % takePaths.length)},atrim=duration=${n3(s.durationSec)}[c${i}]`).join(";");
  let last = "c0";
  for (let i = 1; i < n; i++) {
    graph += `;[${last}][c${i}]acrossfade=d=${n3(x)}:c1=tri:c2=tri[j${i}]`;
    last = `j${i}`;
  }
  graph += `;[${last}]atrim=duration=${n3(span)}${fade}[out]`;
  return ["-nostdin", ...inputs, "-filter_complex", graph, "-map", "[out]", ...WAV_OUT, outPath];
}

/** Squelch/click: SQUELCH_SEC of band-passed white noise that fades out (synthesized, no vendor). */
const SQUELCH_SRC = `anoisesrc=d=${SQUELCH_SEC}:c=white:r=${SAMPLE_RATE}:a=0.3`;
export const RADIO_CHAIN = "highpass=f=300,lowpass=f=3400,volume=6dB,asoftclip=type=tanh,volume=-5dB,acrusher=bits=10:mix=0.2:mode=log:aa=1";

/** One dialogue clip → a WAV stem. Radio: squelch + band-limited mono voice + squelch; else stereo as delivered. */
export function dialogueStemArgs(radio: boolean, inPath: string, outPath: string): string[] {
  if (!radio) {
    return ["-nostdin", "-i", inPath, "-filter_complex", `[0:a]${AFORMAT}[out]`, "-map", "[out]", ...WAV_OUT, outPath];
  }
  const mono = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=mono`;
  const graph =
    `[0:a]${mono},${RADIO_CHAIN}[v];` +
    `[1:a]${mono},highpass=f=1200,lowpass=f=5000,afade=t=out:st=${n3(SQUELCH_SEC / 2)}:d=${n3(SQUELCH_SEC / 2)},asplit=2[s1][s2];` +
    `[s1][v][s2]concat=n=3:v=0:a=1,${AFORMAT}[out]`;
  return ["-nostdin", "-i", inPath, "-f", "lavfi", "-i", SQUELCH_SRC, "-filter_complex", graph, "-map", "[out]", ...WAV_OUT, outPath];
}

// --- Timeline mix -------------------------------------------------------------------------------

export type Stem = { path: string; atSec: number; gainDb: number; duck: boolean };
export type Interval = { start: number; end: number };

/**
 * volume expression (t = timeline seconds) that is DUCK_DB inside every interval and 0 dB outside,
 * with DUCK_RAMP_SEC linear ramps either side. Null when there is nothing to duck under.
 */
export function duckExpr(intervals: Interval[], db = DUCK_DB, ramp = DUCK_RAMP_SEC): string | null {
  if (intervals.length === 0) return null;
  const terms = intervals.map(({ start, end }) => `clip(min((t-${n3(start - ramp)})/${ramp},(${n3(end + ramp)}-t)/${ramp}),0,1)`);
  const depth = terms.reduce((acc, term) => `max(${acc},${term})`);
  return `pow(10,${db}*${depth}/20)`;
}

/**
 * The timeline mix: each stem → stereo 44.1 kHz → gain → `adelay` by its exact sample offset →
 * (ducked under dialogue) → `amix normalize=0` → padded and trimmed to exactly `frames` samples.
 * Output is a float WAV at `outPath` (the master pass reads it twice for two-pass loudnorm).
 */
export function mixArgs(stems: Stem[], duck: Interval[], outPath: string, frames = STORY_FRAMES): string[] {
  if (stems.length === 0) throw new Error("mix needs at least one stem");
  const expr = duckExpr(duck);
  const chains = stems.map((s, i) => {
    const delay = Math.round(s.atSec * SAMPLE_RATE);
    const ducked = s.duck && expr ? `,volume='${expr}':eval=frame` : "";
    return `[${i}:a]${AFORMAT},volume=${s.gainDb}dB,adelay=delays=${delay}S:all=1${ducked}[s${i}]`;
  });
  const labels = stems.map((_, i) => `[s${i}]`).join("");
  const graph = `${chains.join(";")};${labels}amix=inputs=${stems.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_len=${frames},atrim=end_sample=${frames}[out]`;
  return ["-nostdin", ...stems.flatMap((s) => ["-i", s.path]), "-filter_complex", graph, "-map", "[out]", ...WAV_OUT, outPath];
}

export type LoudnormMeasure = { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };

/** Second loudnorm pass (linear, with pass-1 measurements) → exact length → 1 s fade-out at 89 s. No fade-in. */
export function masterChain(m: LoudnormMeasure, frames = STORY_FRAMES): string {
  return (
    `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,` +
    `aresample=${SAMPLE_RATE},apad=whole_len=${frames},atrim=end_sample=${frames},afade=t=out:st=${FINAL_FADE.st}:d=${FINAL_FADE.d}`
  );
}

// --- Loudness timeline --------------------------------------------------------------------------

/** Momentary loudness (400 ms) points from ffmpeg's `ebur128` filter log, one per 100 ms. */
export function parseEbur128(log: string): { t: number; m: number }[] {
  const out: { t: number; m: number }[] = [];
  for (const match of log.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-?inf|nan)/gi)) {
    const m = Number(match[2]);
    out.push({ t: Number(match[1]), m: Number.isFinite(m) ? m : -120 });
  }
  return out;
}

/** Energy-averaged loudness per `windowSec` window (LUFS; −Infinity for an empty window). */
export function windowLoudness(points: { t: number; m: number }[], totalSec = STORY_SEC, windowSec = 5): number[] {
  const n = Math.ceil(totalSec / windowSec);
  const sums = new Array<number>(n).fill(0);
  const counts = new Array<number>(n).fill(0);
  for (const { t, m } of points) {
    const k = Math.min(n - 1, Math.floor((t - 1e-9) / windowSec));
    if (k < 0) continue;
    sums[k]! += 10 ** (m / 10);
    counts[k]!++;
  }
  return sums.map((s, k) => (counts[k] && s > 0 ? 10 * Math.log10(s / counts[k]!) : -Infinity));
}

/** Longest run (seconds) of consecutive momentary points below `thresholdLufs` — a "gap" in the sound. */
export function longestQuietRun(points: { t: number; m: number }[], thresholdLufs = -40, stepSec = 0.1): number {
  let best = 0;
  let run = 0;
  for (const { m } of points) {
    run = m < thresholdLufs ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return Math.round(best * stepSec * 10) / 10;
}

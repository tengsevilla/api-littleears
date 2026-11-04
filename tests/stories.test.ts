// Story generator: ElevenLabs dialogue adapter (SDK mocked), vendor text limits, cache keys,
// timeline/mix graph (incl. a real ffmpeg run on a short timeline), loudness-timeline parsing,
// the story data, the optional env var, and a `--mock --only cars` end-to-end run. No network.
import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ElevenLabsError, ElevenLabsTimeoutError } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsDialogueProvider, MAX_DIALOGUE_CHARS, chunkDialogue } from "../src/providers/elevenlabs/dialogue.js";
import { MockDialogueProvider } from "../src/providers/mock/index.js";
import { failureText } from "../src/providers/errors.js";
import { parseEnv } from "../src/lib/env.js";
import { runFfmpeg } from "../src/lib/ffmpeg.js";
import { hasValidRiffSize } from "../src/lib/soundscape.js";
import { STORIES, VOICES } from "../src/lib/storyData.js";
import {
  STORY_FRAMES,
  BED_FLOOR_LUFS,
  SPOT_FLOOR_LUFS,
  bedSegments,
  liftFor,
  longestRmsGap,
  sfxStemArgs,
  cacheKey,
  dialogueClip,
  duckExpr,
  longestQuietRun,
  masterChain,
  mixArgs,
  parseEbur128,
  sfxClips,
  validateStory,
  windowLoudness,
  type StoryDialogue,
  type StorySfx,
} from "../src/lib/stories.js";

const stream = (bytes: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

// --- Provider ----------------------------------------------------------------------------------

describe("ElevenLabsDialogueProvider", () => {
  type Client = ConstructorParameters<typeof ElevenLabsDialogueProvider>[0]["client"];

  it("maps to textToDialogue.convert: inputs { text, voiceId }, model from env, mp3_44100_128 (192 needs Creator tier)", async () => {
    const convert = vi.fn(async () => stream(Buffer.from("dlg")));
    const client = { textToDialogue: { convert } } as unknown as Client;
    const out = await new ElevenLabsDialogueProvider({ apiKey: "x", model: "eleven_v3", client }).generate({
      lines: [
        { text: "Radio check!", voiceId: "a" },
        { text: "[excited] Loud and clear!", voiceId: "b" },
      ],
    });
    expect(out.toString()).toBe("dlg");
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith(
      { inputs: [{ text: "Radio check!", voiceId: "a" }, { text: "[excited] Loud and clear!", voiceId: "b" }], modelId: "eleven_v3", outputFormat: "mp3_44100_128" },
      expect.objectContaining({ maxRetries: 0, timeoutInSeconds: expect.any(Number) }),
    );
  });

  it("splits a request over 2000 characters into several calls and concatenates the audio", async () => {
    let n = 0;
    const convert = vi.fn(async () => stream(Buffer.from(`part${++n};`)));
    const long = "a".repeat(1200);
    const out = await new ElevenLabsDialogueProvider({ apiKey: "x", model: "m", client: { textToDialogue: { convert } } as never }).generate({
      lines: [
        { text: long, voiceId: "v1" },
        { text: long, voiceId: "v2" },
      ],
    });
    expect(convert).toHaveBeenCalledTimes(2);
    expect(out.toString()).toBe("part1;part2;");
  });

  it("rejects a line over the limit before calling the vendor", async () => {
    const convert = vi.fn();
    const p = new ElevenLabsDialogueProvider({ apiKey: "x", model: "m", client: { textToDialogue: { convert } } as never });
    await expect(p.generate({ lines: [{ text: "a".repeat(MAX_DIALOGUE_CHARS + 1), voiceId: "v" }] })).rejects.toThrow(/2001 characters/);
    expect(convert).not.toHaveBeenCalled();
  });

  it.each([
    ["401 quota_exceeded", () => new ElevenLabsError({ message: "Status code: 401", statusCode: 401, body: { detail: { status: "quota_exceeded" } } }), "PROVIDER_QUOTA", false],
    ["429 busy", () => new ElevenLabsError({ message: "Status code: 429", statusCode: 429, body: { detail: { status: "system_busy" } } }), "PROVIDER_QUOTA", true],
    ["403 plan does not allow the output format", () => new ElevenLabsError({ message: "Status code: 403", statusCode: 403, body: { detail: { code: "subscription_required", status: "output_format_not_allowed", message: "Output format 'mp3_44100_192' is only available on the Creator tier and above." } } }), "PROVIDER_REJECTED", false],
    ["403 bad key permissions", () => new ElevenLabsError({ message: "Status code: 403", statusCode: 403, body: { detail: { status: "missing_permissions" } } }), "PROVIDER_UNAVAILABLE", false],
    ["422 validation", () => new ElevenLabsError({ message: "Status code: 422", statusCode: 422, body: { detail: [{ msg: "invalid voice_id" }] } }), "PROVIDER_REJECTED", false],
    ["500", () => new ElevenLabsError({ message: "Status code: 500", statusCode: 500 }), "PROVIDER_UNAVAILABLE", true],
    ["timeout", () => new ElevenLabsTimeoutError("Timeout exceeded when calling POST /v1/text-to-dialogue."), "PROVIDER_UNAVAILABLE", true],
  ] as const)("maps SDK %s → %s", async (_label, makeErr, code, transient) => {
    const convert = vi.fn(async () => {
      throw makeErr();
    });
    const p = new ElevenLabsDialogueProvider({ apiKey: "x", model: "m", client: { textToDialogue: { convert } } as never });
    await expect(p.generate({ lines: [{ text: "hi", voiceId: "v" }] })).rejects.toMatchObject({ code, transient, vendor: "elevenlabs" });
  });

  it("failureText adds the vendor's status and detail message, nothing else", async () => {
    const convert = vi.fn(async () => {
      throw (new ElevenLabsError({ message: "Status code: 403", statusCode: 403, body: { detail: { code: "subscription_required", status: "output_format_not_allowed", message: "Output format 'mp3_44100_192' is only available on the Creator tier and above." } } }));
    });
    const p = new ElevenLabsDialogueProvider({ apiKey: "sk_secret_key", model: "m", client: { textToDialogue: { convert } } as never });
    const err = await p.generate({ lines: [{ text: "hi", voiceId: "v" }] }).catch((e: unknown) => e);
    const text = failureText(err);
    expect(text).toBe(
      "elevenlabs provider rejected the request (HTTP 403, code=subscription_required, status=output_format_not_allowed, " +
        "message=Output format 'mp3_44100_192' is only available on the Creator tier and above.)",
    );
    expect(text).not.toContain("sk_secret_key");
    expect(failureText(new Error("plain"))).toBe("plain");
  });

  it("mock returns a decodable MP3 that grows with the text", async () => {
    const decodeFrames = async (mp3: Buffer) => (await runFfmpeg(["-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "44100", "pipe:1"], mp3)).length / 4;
    const mock = new MockDialogueProvider();
    const short = await decodeFrames(await mock.generate({ lines: [{ text: "Hi", voiceId: "a" }] }));
    const long = await decodeFrames(await mock.generate({ lines: [{ text: "Hello there, this is longer", voiceId: "a" }, { text: "Yes!", voiceId: "b" }] }));
    expect(short).toBeGreaterThanOrEqual(0.8 * 44_100 - 2_000);
    expect(long).toBeGreaterThan(short);
  }, 60_000); // several ffmpeg runs; slow under full-suite load
});

// --- Limits ------------------------------------------------------------------------------------

describe("chunkDialogue", () => {
  const line = (chars: number, voiceId = "v") => ({ text: "x".repeat(chars), voiceId });

  it("keeps a request within 2000 characters, splitting on line boundaries in order", () => {
    expect(chunkDialogue([line(1000), line(1000)])).toHaveLength(1);
    const chunks = chunkDialogue([line(1000), line(1000), line(1)]);
    expect(chunks.map((c) => c.map((l) => l.text.length))).toEqual([[1000, 1000], [1]]);
  });

  it("keeps a request within 10 distinct voices", () => {
    const lines = Array.from({ length: 11 }, (_, i) => line(5, `v${i}`));
    const chunks = chunkDialogue(lines);
    expect(chunks.map((c) => new Set(c.map((l) => l.voiceId)).size)).toEqual([10, 1]);
    // A repeated voice does not count twice.
    expect(chunkDialogue([...lines.slice(0, 10), line(5, "v0")])).toHaveLength(1);
  });

  it("rejects empty input, empty lines and a single over-long line", () => {
    expect(() => chunkDialogue([])).toThrow(/at least one line/);
    expect(() => chunkDialogue([{ text: "  ", voiceId: "v" }])).toThrow(/needs text/);
    expect(() => chunkDialogue([line(2001)])).toThrow(/max 2000/);
  });
});

// --- Cache key ---------------------------------------------------------------------------------

describe("cacheKey", () => {
  const dlg: StoryDialogue = { id: "radio", atSec: 8, radio: true, gainDb: 0, lines: [{ voice: "engineer", text: "Loud and clear!" }] };
  const keyOf = (d: StoryDialogue, model = "eleven_v3") => dialogueClip(d, VOICES, model).key;

  it("is a stable sha256 of what the vendor receives", () => {
    expect(keyOf(dlg)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(dlg)).toBe(keyOf({ ...dlg }));
  });

  it("changes with the text, the voice or the model — so only that clip is re-bought", () => {
    expect(keyOf({ ...dlg, lines: [{ voice: "engineer", text: "Loud and clear!!" }] })).not.toBe(keyOf(dlg));
    expect(keyOf({ ...dlg, lines: [{ voice: "hero", text: "Loud and clear!" }] })).not.toBe(keyOf(dlg));
    expect(keyOf(dlg, "other_model")).not.toBe(keyOf(dlg));
  });

  it("ignores mixing-only fields (time, gain, radio)", () => {
    expect(keyOf({ ...dlg, atSec: 30, gainDb: -6, radio: false, id: "renamed" })).toBe(keyOf(dlg));
    const sfx: StorySfx = { id: "a", atSec: 0, durationSec: 3, gainDb: 0, prompt: "beep" };
    expect(sfxClips({ ...sfx, atSec: 50, gainDb: -9, fadeOutSec: 1 }, "m")[0]!.key).toBe(sfxClips(sfx, "m")[0]!.key);
    expect(sfxClips({ ...sfx, prompt: "boop" }, "m")[0]!.key).not.toBe(sfxClips(sfx, "m")[0]!.key);
    expect(sfxClips({ ...sfx, durationSec: 4 }, "m")[0]!.key).not.toBe(sfxClips(sfx, "m")[0]!.key);
  });

  it("gives each bed take its own file and key", () => {
    const clips = sfxClips({ id: "engine", atSec: 0, untilSec: 90, durationSec: 30, gainDb: 0, prompt: "engine", loop: true, takes: 2 }, "m");
    expect(clips.map((c) => c.file)).toEqual(["engine", "engine-t2"]);
    expect(new Set(clips.map((c) => c.key)).size).toBe(2);
    expect(cacheKey({ kind: "cover", prompt: "a" })).not.toBe(cacheKey({ kind: "cover", prompt: "b" }));
  });
});

// --- Timeline ----------------------------------------------------------------------------------

describe("timeline builder", () => {
  it("delays each stem by its exact sample offset and trims the mix to exactly 90 s", () => {
    const args = mixArgs(
      [
        { path: "bed.wav", atSec: 0, gainDb: -8, duck: true },
        { path: "spot.wav", atSec: 21.2, gainDb: -1, duck: true },
        { path: "radio.wav", atSec: 8.5, gainDb: 0, duck: false },
      ],
      [{ start: 8.5, end: 12 }],
      "mix.wav",
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(args.filter((a) => a.endsWith(".wav"))).toEqual(["bed.wav", "spot.wav", "radio.wav", "mix.wav"]);
    expect(graph).toContain("volume=-8dB,adelay=delays=0S:all=1");
    expect(graph).toContain("volume=-1dB,adelay=delays=934920S:all=1"); // 21.2 × 44100
    expect(graph).toContain("volume=0dB,adelay=delays=374850S:all=1[s2]"); // dialogue: not ducked
    expect(graph.match(/eval=frame/g)).toHaveLength(2); // both sfx stems ducked
    expect(graph).toContain(`amix=inputs=3:normalize=0`);
    expect(graph).toContain(`apad=whole_len=${STORY_FRAMES},atrim=end_sample=${STORY_FRAMES}[out]`);
    expect(STORY_FRAMES).toBe(3_969_000);
  });

  it("ducks by 6 dB with short ramps, and not at all without speech", () => {
    expect(duckExpr([])).toBeNull();
    const expr = duckExpr([{ start: 10, end: 12 }, { start: 40, end: 43.5 }])!;
    expect(expr).toMatch(/^pow\(10,-6\*max\(clip\(min\(\(t-9\.75\)\/0\.25,\(12\.25-t\)\/0\.25\),0,1\),clip\(.*\)\)\/20\)$/);
  });

  it("bed segment count covers the span with crossfades (+1 spare)", () => {
    const bed = (atSec: number, untilSec: number, durationSec: number): StorySfx => ({ id: "b", atSec, untilSec, durationSec, gainDb: 0, prompt: "p", loop: true });
    expect(bedSegments(bed(0, 20, 30))).toBe(1);
    expect(bedSegments(bed(25, 76, 30))).toBe(3); // 51 s: ceil(49 / 28) = 2 clips + spare
    expect(bedSegments(bed(0, 90, 30))).toBe(5); // 90 s: ceil(88 / 28) = 4 clips + spare
  });

  it("master chain is two-pass linear loudnorm, exact length, 1 s fade at 89 s, no fade-in", () => {
    const chain = masterChain({ input_i: "-20.1", input_tp: "-3.2", input_lra: "5.0", input_thresh: "-30.4", target_offset: "0.1" });
    expect(chain).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-20.1:measured_TP=-3.2:measured_LRA=5.0:measured_thresh=-30.4:offset=0.1:linear=true");
    expect(chain).toContain(`atrim=end_sample=${STORY_FRAMES},afade=t=out:st=89:d=1`);
    expect(chain).not.toContain("t=in");
  });

  it("ffmpeg renders the graph: exact length, tone starts at its delay sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-mix-"));
    try {
      const tone = join(dir, "tone.wav");
      await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.2", "-c:a", "pcm_f32le", "-f", "wav", "-y", tone], Buffer.alloc(0));
      const out = join(dir, "mix.wav");
      const frames = 2 * 44_100;
      await runFfmpeg(mixArgs([{ path: tone, atSec: 0.5, gainDb: 0, duck: true }], [{ start: 1, end: 1.5 }], out, frames), Buffer.alloc(0));
      const pcm = await runFfmpeg(["-i", out, "-f", "f32le", "-ac", "2", "-ar", "44100", "pipe:1"], Buffer.alloc(0));
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      expect(samples.length / 2).toBe(frames);
      let first = -1;
      for (let i = 0; i < samples.length; i += 2) {
        if (Math.abs(samples[i]!) > 1e-4) {
          first = i / 2;
          break;
        }
      }
      expect(first).toBeGreaterThanOrEqual(22_050);
      expect(first).toBeLessThan(22_050 + 10); // sine starts at 0, first audible sample right after
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- Level conditioning ------------------------------------------------------------------------

describe("level conditioning", () => {
  it("lifts a quiet bed to −24 and a quiet spot to −22 LUFS, never lowers, caps at +30 dB", () => {
    expect(BED_FLOOR_LUFS).toBe(-24);
    expect(SPOT_FLOOR_LUFS).toBe(-22);
    expect(liftFor(-45.5, -30, true)).toEqual({ gainDb: 21.5, limit: false });
    expect(liftFor(-30.7, -12, false)).toEqual({ gainDb: 8.7, limit: false });
    expect(liftFor(-10.6, -1, false)).toBeNull(); // loud: untouched
    expect(liftFor(-23, -5, true)).toBeNull(); // above the bed floor
    expect(liftFor(-23, -5, false)).toEqual({ gainDb: 1, limit: false }); // below the spot floor
    expect(liftFor(-70, -40, true)).toEqual({ gainDb: 30, limit: false });
    expect(liftFor(-Infinity, -Infinity, true)).toEqual({ gainDb: 30, limit: false });
  });

  it("adds a peak limiter only when the lift would push the peak over −1 dBTP", () => {
    expect(liftFor(-40, -10, true)).toEqual({ gainDb: 16, limit: true });
    expect(liftFor(-40, -17.5, true)).toEqual({ gainDb: 16, limit: false });
  });

  it("puts the lift on each take before trimming; no lift = the exact unlifted graph", () => {
    const spot: StorySfx = { id: "pig", atSec: 1, durationSec: 4, gainDb: -3, prompt: "pig" };
    const graphOf = (a: string[]) => a[a.indexOf("-filter_complex") + 1]!;
    expect(graphOf(sfxStemArgs(spot, ["pig.mp3"], "o.wav", [null]))).toBe(graphOf(sfxStemArgs(spot, ["pig.mp3"], "o.wav")));
    expect(graphOf(sfxStemArgs(spot, ["pig.mp3"], "o.wav", [{ gainDb: 8, limit: false }]))).toMatch(/channel_layouts=stereo,volume=8dB,atrim=/);
    const bed: StorySfx = { id: "yard", atSec: 0, untilSec: 90, durationSec: 30, gainDb: -12, prompt: "yard", loop: true, takes: 2 };
    const g = graphOf(sfxStemArgs(bed, ["t1.mp3", "t2.mp3"], "o.wav", [{ gainDb: 21.5, limit: true }, null]));
    expect(g).toContain("[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=21.5dB,alimiter=limit=0.89125");
    expect(g).toContain("[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim="); // take 2 unlifted
    expect(g).toContain("[2:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=21.5dB"); // take 1 again
  });

  it("finds the longest stretch of 100 ms blocks below −45 dBFS RMS", () => {
    const rate = 1000; // 100 frames per block
    const pcm = new Float32Array(1000 * 2).fill(0.1); // −20 dBFS
    pcm.fill(0.001, 200 * 2, 550 * 2); // −60 dBFS from 0.2 to 0.55 s → blocks 2, 3, 4 fully quiet
    expect(longestRmsGap(pcm, 2, rate)).toBe(0.3);
    expect(longestRmsGap(new Float32Array(2000).fill(0.1), 2, rate)).toBe(0);
  });
});

// --- Loudness timeline -------------------------------------------------------------------------

describe("loudness timeline", () => {
  const log = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.1       TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 2.5       TARGET:-23 LUFS    M: -20.0 S: -21.0     I: -20.0 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 6         TARGET:-23 LUFS    M: -50.0 S: -40.0     I: -20.0 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 6.1       TARGET:-23 LUFS    M: -50.0 S: -40.0     I: -20.0 LUFS       LRA:   0.0 LU",
  ].join("\n");

  it("parses momentary loudness points", () => {
    expect(parseEbur128(log)).toEqual([
      { t: 0.1, m: -120.7 },
      { t: 2.5, m: -20 },
      { t: 6, m: -50 },
      { t: 6.1, m: -50 },
    ]);
  });

  it("energy-averages 5 s windows and finds the longest quiet stretch", () => {
    const w = windowLoudness(parseEbur128(log), 15, 5);
    expect(w[0]).toBeCloseTo(-20 - 10 * Math.log10(2), 1); // −120.7 adds ~no energy
    expect(w[1]).toBeCloseTo(-50, 5);
    expect(w[2]).toBe(-Infinity);
    expect(longestQuietRun(parseEbur128(log))).toBe(0.2);
  });
});

// --- Story data --------------------------------------------------------------------------------

describe("STORIES", () => {
  it("has the 5 stories, all valid, each dialogue within the vendor limits", () => {
    expect(STORIES.map((s) => s.slug)).toEqual(["cars", "farm", "train", "construction", "rocket"]);
    for (const s of STORIES) {
      expect(validateStory(s, VOICES)).toEqual([]);
      for (const d of s.dialogue) expect(() => chunkDialogue(dialogueClip(d, VOICES, "m").lines)).not.toThrow();
    }
  });

  it("covers the whole 90 s with beds (no silent gap)", () => {
    for (const s of STORIES) {
      const covered = new Array<boolean>(90).fill(false);
      for (const x of s.sfx) {
        const end = x.untilSec ?? x.atSec + x.durationSec;
        for (let t = Math.floor(x.atSec); t < Math.ceil(end) && t < 90; t++) covered[t] = true;
      }
      expect(covered.indexOf(false), s.slug).toBe(-1);
    }
  });

  it("never asks for anything scary, and never names real brands or people", () => {
    const banned = /\b(crash\w*|sirens?|scary|scream\w*|monster|danger\w*|explo\w*|injur\w*|hurt|blood|fire alarm|ferrari|mercedes|red bull|mclaren|nasa|spacex|hamilton|verstappen)\b/i;
    for (const s of STORIES) {
      for (const t of [s.cover, ...s.sfx.map((x) => x.prompt), ...s.dialogue.flatMap((d) => d.lines.map((l) => l.text))]) expect(t, s.slug).not.toMatch(banned);
    }
  });

  it("covers never contain people", () => {
    for (const s of STORIES) expect(s.cover).not.toMatch(/\b(boy|girl|child|kid|man|woman|people|person|driver|astronaut|farmer|named?)\b/i);
  });
});

// --- Env ---------------------------------------------------------------------------------------

describe("ELEVENLABS_DIALOGUE_MODEL", () => {
  const base = { ...process.env } as Record<string, string | undefined>;
  it("defaults to eleven_v3 and is not required in production", () => {
    expect(parseEnv({ ...base, ELEVENLABS_DIALOGUE_MODEL: undefined }).ELEVENLABS_DIALOGUE_MODEL).toBe("eleven_v3");
    const prod = parseEnv({ ...base, NODE_ENV: "production", APP_URL: "https://app.example.test", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", ELEVENLABS_DIALOGUE_MODEL: "" });
    expect(prod.ELEVENLABS_DIALOGUE_MODEL).toBe("eleven_v3");
    expect(parseEnv({ ...base, ELEVENLABS_DIALOGUE_MODEL: "other" }).ELEVENLABS_DIALOGUE_MODEL).toBe("other");
  });
});

// --- End to end --------------------------------------------------------------------------------

describe("stories:generate --mock --only cars", () => {
  const apiRoot = fileURLToPath(new URL("../", import.meta.url));
  const mockOut = join(apiRoot, "out", "stories-mock");
  const run = (extra: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const proc = spawn(process.execPath, ["--import", "tsx", "src/scripts/generateStories.ts", "--mock", "--only", "cars", ...extra], { cwd: apiRoot });
      let out = "";
      proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
      proc.stderr.on("data", (c: Buffer) => (out += c.toString()));
      proc.on("close", (code) => resolve({ code, out }));
    });

  it("--remix with an empty cache fails without calling a vendor; a full mock run builds a 90.000 s MP3, WebP and manifest", async () => {
    await rm(mockOut, { recursive: true, force: true });
    try {
      const remix = await run(["--remix"]);
      expect(remix.code).toBe(1);
      expect(remix.out).toMatch(/--remix: missing or out-of-date clips: .*visor-click/);

      const { code, out } = await run([]);
      expect(code, out).toBe(0);
      expect(out).toContain(`samples=${STORY_FRAMES} `);
      expect(out).toMatch(/I=-1[5-7]\.\d+ LUFS/);
      expect(out).toMatch(/windows quieter than -30 LUFS: \d+\.\d%/);
      expect(out).toMatch(/vendor calls: \d+ made, \d+ cached/);
      expect(hasValidRiffSize(await readFile(join(mockOut, "cars.webp")))).toBe(true);
      const manifest = JSON.parse(await readFile(join(mockOut, "manifest.json"), "utf8")) as { slug: string; durationSamples: number }[];
      expect(manifest).toEqual([expect.objectContaining({ slug: "cars", durationSamples: STORY_FRAMES })]);
      expect(existsSync(join(mockOut, "work"))).toBe(false);
    } finally {
      await rm(mockOut, { recursive: true, force: true });
    }
  }, 400_000);
});

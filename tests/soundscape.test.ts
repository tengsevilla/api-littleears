// Soundscape generator: ElevenLabs sound-effects adapter (SDK mocked), loop-seam math on
// synthetic PCM, the fixed sound list, and the optional ELEVENLABS_SFX_MODEL env var. No network.
import { describe, it, expect, vi } from "vitest";
import { ElevenLabsError, ElevenLabsTimeoutError } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsSoundEffectsProvider } from "../src/providers/elevenlabs/soundEffects.js";
import { MockSoundEffectsProvider } from "../src/providers/mock/index.js";
import { parseEnv } from "../src/lib/env.js";
import { runFfmpeg } from "../src/lib/ffmpeg.js";
import {
  LOOP_END_SAMPLE,
  LOOP_FRAMES,
  LOOP_PAD_FRAMES,
  LOOP_START_SAMPLE,
  SOUNDSCAPES,
  closeLoop,
  hasValidRiffSize,
  padCircular,
  seamStats,
} from "../src/lib/soundscape.js";

const seamJump = (pcm: Float32Array, ch: number) => seamStats(pcm, ch, 0, pcm.length / ch).seamStep;

const stream = (bytes: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

// --- Provider ----------------------------------------------------------------------------------

describe("ElevenLabsSoundEffectsProvider", () => {
  type Client = ConstructorParameters<typeof ElevenLabsSoundEffectsProvider>[0]["client"];

  it("maps to textToSoundEffects.convert: text, durationSeconds, loop, promptInfluence 0.5, model from env, mp3 192k", async () => {
    const convert = vi.fn(async () => stream(Buffer.from("sfx")));
    const client = { textToSoundEffects: { convert } } as unknown as Client;
    const out = await new ElevenLabsSoundEffectsProvider({ apiKey: "x", model: "sfx-from-env", client }).generate({
      text: "gentle rain",
      durationSec: 30,
      loop: true,
    });
    expect(out.toString()).toBe("sfx");
    expect(convert).toHaveBeenCalledWith(
      { text: "gentle rain", durationSeconds: 30, loop: true, promptInfluence: 0.5, modelId: "sfx-from-env", outputFormat: "mp3_44100_192" },
      expect.objectContaining({ maxRetries: 0, timeoutInSeconds: expect.any(Number) }),
    );
  });

  it.each([
    ["401 quota_exceeded", () => new ElevenLabsError({ message: "Status code: 401", statusCode: 401, body: { detail: { status: "quota_exceeded" } } }), "PROVIDER_QUOTA", false],
    ["429 busy", () => new ElevenLabsError({ message: "Status code: 429", statusCode: 429, body: { detail: { status: "system_busy" } } }), "PROVIDER_QUOTA", true],
    ["422 validation", () => new ElevenLabsError({ message: "Status code: 422", statusCode: 422, body: { detail: [{ msg: "duration_seconds out of range" }] } }), "PROVIDER_REJECTED", false],
    ["500", () => new ElevenLabsError({ message: "Status code: 500", statusCode: 500 }), "PROVIDER_UNAVAILABLE", true],
    ["timeout", () => new ElevenLabsTimeoutError("Timeout exceeded when calling POST /v1/sound-generation."), "PROVIDER_UNAVAILABLE", true],
  ] as const)("maps SDK %s → %s", async (_label, makeErr, code, transient) => {
    const convert = vi.fn(async () => {
      throw makeErr();
    });
    const sfx = new ElevenLabsSoundEffectsProvider({ apiKey: "x", model: "m", client: { textToSoundEffects: { convert } } as never });
    await expect(sfx.generate({ text: "waves", durationSec: 30, loop: true })).rejects.toMatchObject({ code, transient, vendor: "elevenlabs" });
  });

  it("mock returns a decodable MP3 of the requested length", async () => {
    const mp3 = await new MockSoundEffectsProvider().generate({ durationSec: 1 });
    const pcm = await runFfmpeg(["-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", "44100", "pipe:1"], mp3);
    expect(pcm.length / 8).toBeGreaterThanOrEqual(44_100); // ≥ 1 s stereo float frames
  });
});

// --- Seam math ---------------------------------------------------------------------------------

/** Interleaved stereo sine; right channel phase-shifted so channels differ. */
function sine(frames: number, freq = 220, rate = 44_100, phase = 0): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate + phase);
    out[i * 2 + 1] = 0.5 * Math.cos((2 * Math.PI * freq * i) / rate + phase);
  }
  return out;
}

const maxStep = (pcm: Float32Array) => {
  let m = 0;
  for (let i = 2; i < pcm.length; i++) m = Math.max(m, Math.abs(pcm[i]! - pcm[i - 2]!));
  return m;
};

describe("closeLoop", () => {
  it("returns exactly `frames` frames (90 s at 44.1 kHz = 3,969,000)", () => {
    const frames = 90 * 44_100;
    const out = closeLoop(sine(frames + 2 * 44_100 + 500), 2, frames, 2 * 44_100);
    expect(out.length).toBe(frames * 2);
  });

  it("the last sample flows into the first: out[0] is the sample that followed out[frames-1]", () => {
    const frames = 10_000;
    const fade = 1_000;
    // Ramp so every frame is distinct: the wrap must land on input frame `frames`.
    const pcm = new Float32Array((frames + fade + 50) * 2).map((_, i) => Math.floor(i / 2) / 100_000);
    const out = closeLoop(pcm, 2, frames, fade);
    expect(out[0]).toBe(pcm[frames * 2]); // equal-power: head gain sin(0)=0, tail gain cos(0)=1
    expect(out[1]).toBe(pcm[frames * 2 + 1]);
    expect(out.subarray(fade * 2)).toEqual(pcm.subarray(fade * 2, frames * 2)); // untouched after the fade
  });

  it("seam jump is no bigger than a normal sample step for continuous audio (incoherent loop point)", () => {
    const frames = 44_100 * 3;
    const fade = 44_100 / 2;
    // 217.3 Hz: the loop length is not a whole number of cycles, so a plain cut would click.
    const pcm = sine(frames + fade, 217.3);
    const plainCut = pcm.slice(0, frames * 2);
    expect(seamJump(plainCut, 2)).toBeGreaterThan(maxStep(pcm) * 5);

    const out = closeLoop(pcm, 2, frames, fade);
    expect(seamJump(out, 2)).toBeLessThanOrEqual(maxStep(pcm) * 1.01);
    // No discontinuity anywhere (incl. the end of the fade). Equal-power on two COHERENT sines can
    // lift the amplitude by up to √2 mid-fade (it is designed for uncorrelated audio), so allow that.
    expect(maxStep(out)).toBeLessThanOrEqual(maxStep(pcm) * Math.SQRT2 * 1.01);
  });

  it("equal-power: two uncorrelated equal-level signals keep their level through the fade", () => {
    const frames = 20_000;
    const fade = 10_000;
    let seed = 1;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const noise = new Float32Array((frames + fade) * 2).map(rand);
    const out = closeLoop(noise, 2, frames, fade);
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const mid = out.subarray((fade / 2 - 1000) * 2, (fade / 2 + 1000) * 2); // centre of the fade
    expect(rms(mid) / rms(noise)).toBeGreaterThan(0.9);
    expect(rms(mid) / rms(noise)).toBeLessThan(1.1);
  });

  it("throws when the input is too short", () => {
    expect(() => closeLoop(new Float32Array(100), 2, 40, 20)).toThrow(/need 60 frames/);
  });
});

describe("padCircular", () => {
  it("wraps the loop's own tail before and head after", () => {
    const pcm = new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(Array.from(padCircular(pcm, 2, 1))).toEqual([4, 4, 1, 1, 2, 2, 3, 3, 4, 4, 1, 1]);
  });

  it("shipped layout: 1 s pad each side, loop points 44100 / 4013100, total 3,969,000 + 2×44,100", () => {
    expect(LOOP_START_SAMPLE).toBe(44_100);
    expect(LOOP_END_SAMPLE).toBe(4_013_100);
    expect(LOOP_END_SAMPLE - LOOP_START_SAMPLE).toBe(LOOP_FRAMES);
    const shipped = padCircular(new Float32Array(LOOP_FRAMES * 2), 2, LOOP_PAD_FRAMES);
    expect(shipped.length / 2).toBe(3_969_000 + 2 * 44_100);
  });

  it("a seamless loop stays seamless at the loop points and under a decoder offset", () => {
    const frames = 30_000;
    const fade = 5_000;
    const pad = 4_000;
    const loop = closeLoop(sine(frames + fade, 217.3), 2, frames, fade);
    const shipped = padCircular(loop, 2, pad);
    const steps = seamStats(shipped, 2, pad, pad + frames);
    expect(steps.seamStep).toBeLessThanOrEqual(steps.maxStep);
    expect(steps.percentile).toBeLessThan(100);
    // the player's window lands a few hundred samples early or late: still continuous
    for (const k of [-700, -1, 1, 700]) {
      const shiftedSeam = seamStats(shipped, 2, pad + k, pad + frames + k);
      expect(shiftedSeam.seamStep).toBeLessThanOrEqual(steps.maxStep * 1.01);
    }
  });
});

describe("hasValidRiffSize", () => {
  const riff = (size: number, body = 8) => {
    const b = Buffer.alloc(8 + body);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(size, 4);
    b.write("WEBP", 8, "ascii");
    return b;
  };
  it("accepts size = filesize − 8 and rejects 0 (piped output), wrong sizes and non-RIFF data", () => {
    expect(hasValidRiffSize(riff(8))).toBe(true);
    expect(hasValidRiffSize(riff(0))).toBe(false);
    expect(hasValidRiffSize(riff(7))).toBe(false);
    expect(hasValidRiffSize(Buffer.from("not a riff file at all"))).toBe(false);
    expect(hasValidRiffSize(Buffer.alloc(4))).toBe(false);
  });

  it("an ffmpeg WebP written straight to a file path passes", async () => {
    const { mkdtemp, readFile: read, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "webp-"));
    try {
      const src = ["-f", "lavfi", "-i", "color=c=pink:s=64x64", "-frames:v", "1", "-c:v", "libwebp", "-f", "webp"];
      await runFfmpeg([...src, "-y", join(dir, "cover.webp")], Buffer.alloc(0));
      expect(hasValidRiffSize(await read(join(dir, "cover.webp")))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("seamStats", () => {
  it("ranks the wrap step within the in-loop step distribution", () => {
    // Steps inside the loop: 1, 1, 1, 10 (frames 0..4); wrap 4 → 0 = |13 − 0| = 13 → above all steps.
    const pcm = new Float32Array([0, 1, 2, 3, 13]);
    expect(seamStats(pcm, 1, 0, 5)).toEqual({ seamStep: 13, percentile: 100, maxStep: 10, meanStep: 13 / 4 });
    // Loop [0, 4): steps 1,1,1; wrap |3 − 0| = 3 → larger than every step.
    expect(seamStats(pcm, 1, 0, 4).percentile).toBe(100);
    // Smooth wrap: 0,1,2,1 → wrap |1 − 0| = 1, not above any step.
    expect(seamStats(new Float32Array([0, 1, 2, 1]), 1, 0, 4)).toMatchObject({ seamStep: 1, percentile: 0 });
  });

  it("rejects a window outside the buffer", () => {
    expect(() => seamStats(new Float32Array(10), 2, 0, 6)).toThrow(/outside/);
  });
});

// --- Sound list --------------------------------------------------------------------------------

describe("SOUNDSCAPES", () => {
  it("has the 8 fixed slugs, each with a title, 3 distinct prompts and a cover", () => {
    expect(SOUNDSCAPES.map((s) => s.slug)).toEqual(["construction", "farm", "cars", "rocket", "train", "ocean", "jungle", "rain"]);
    for (const s of SOUNDSCAPES) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(new Set(s.prompts).size).toBe(3);
      expect(s.cover.length).toBeGreaterThan(0);
    }
  });

  it("prompts never ask for voices, speech, music or anything scary", () => {
    const banned = /\b(voices?|speech|speak\w*|talk\w*|words?|sing\w*|songs?|music\w*|melod\w*|lyrics?|scream\w*|sirens?|crash\w*|explo\w*|countdown|scary|monster|danger\w*)\b/i;
    for (const s of SOUNDSCAPES) for (const p of [...s.prompts, s.cover]) expect(p).not.toMatch(banned);
  });

  it("covers ask for no text and never contain people", () => {
    for (const s of SOUNDSCAPES) expect(s.cover).not.toMatch(/\b(boy|girl|child|kid|man|woman|people|person|named?)\b/i);
  });
});

// --- Env ---------------------------------------------------------------------------------------

describe("ELEVENLABS_SFX_MODEL", () => {
  const base = { ...process.env } as Record<string, string | undefined>;
  it("defaults to eleven_text_to_sound_v2 and is not required in production", () => {
    expect(parseEnv({ ...base, ELEVENLABS_SFX_MODEL: undefined }).ELEVENLABS_SFX_MODEL).toBe("eleven_text_to_sound_v2");
    const prod = parseEnv({ ...base, NODE_ENV: "production", APP_URL: "https://app.example.test", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", ELEVENLABS_SFX_MODEL: "" });
    expect(prod.ELEVENLABS_SFX_MODEL).toBe("eleven_text_to_sound_v2");
    expect(parseEnv({ ...base, ELEVENLABS_SFX_MODEL: "eleven_text_to_sound_v3" }).ELEVENLABS_SFX_MODEL).toBe("eleven_text_to_sound_v3");
  });
});

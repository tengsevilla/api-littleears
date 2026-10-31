// Provider layer: registry selection, vendor error mapping (SDK clients mocked), structured-output
// parsing, STYLE_PROMPT, music request shape, mock providers. No network.
import { describe, it, expect, vi } from "vitest";
import OpenAI, { APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { ElevenLabsError, ElevenLabsTimeoutError } from "@elevenlabs/elevenlabs-js";
import { ApiError as GeminiApiError } from "@google/genai";
import { createProviders, type ProviderConfig } from "../src/providers/index.js";
import { ProviderError, toProviderError } from "../src/providers/errors.js";
import { OpenAiLyricsProvider } from "../src/providers/openai/lyrics.js";
import { ElevenLabsMusicProvider, buildCompositionPlan } from "../src/providers/elevenlabs/music.js";
import { ElevenLabsTtsProvider } from "../src/providers/elevenlabs/tts.js";
import { GeminiImageProvider } from "../src/providers/gemini/image.js";
import { STYLE_PROMPT, StyledImageProvider } from "../src/providers/image.js";
import { runFfmpeg } from "../src/lib/ffmpeg.js";
import { MockImageProvider, MockLyricsProvider, MockMusicProvider, MockTtsProvider } from "../src/providers/mock/index.js";
import {
  INVALID_SAFETY_RESPONSE,
  safetySystemPrompt,
  checkUserPrompt,
  effectiveLengthSec,
  parseLyricsDraft,
  parseSafetyResult,
  writeSystemPrompt,
  writeUserPrompt,
} from "../src/providers/lyricsRules.js";

const MOCK: ProviderConfig = { LYRICS_PROVIDER: "mock", MUSIC_PROVIDER: "mock", IMAGE_PROVIDER: "mock" };
const LIVE: ProviderConfig = {
  LYRICS_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODEL: "model-from-env",
  MUSIC_PROVIDER: "elevenlabs",
  ELEVENLABS_API_KEY: "el-test",
  ELEVENLABS_MUSIC_MODEL: "music-from-env",
  ELEVENLABS_TTS_MODEL: "tts-from-env",
  ELEVENLABS_TTS_VOICE_ID: "voice-1",
  IMAGE_PROVIDER: "gemini",
  GEMINI_API_KEY: "g-test",
  GEMINI_IMAGE_MODEL: "image-from-env",
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const VALID_DRAFT = { title: "Sleepy Moon", lyrics: ["Hush now, moon is high", "Stars say goodnight"], musicPrompt: "soft lullaby, 60 bpm", imagePrompt: "A sleepy owl on a crescent moon" };

const stream = (bytes: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

// --- Registry ----------------------------------------------------------------------------------

describe("provider registry", () => {
  it("selects mocks when every *_PROVIDER is mock", () => {
    const p = createProviders(MOCK);
    expect(p.lyrics).toBeInstanceOf(MockLyricsProvider);
    expect(p.music).toBeInstanceOf(MockMusicProvider);
    expect(p.tts).toBeInstanceOf(MockTtsProvider);
    expect(p.image).toBeInstanceOf(StyledImageProvider);
    expect((p.image as StyledImageProvider).inner).toBeInstanceOf(MockImageProvider);
  });

  it("selects vendor adapters from env; TTS follows MUSIC_PROVIDER", () => {
    const p = createProviders(LIVE);
    expect(p.lyrics).toBeInstanceOf(OpenAiLyricsProvider);
    expect(p.music).toBeInstanceOf(ElevenLabsMusicProvider);
    expect(p.tts).toBeInstanceOf(ElevenLabsTtsProvider);
    expect((p.image as StyledImageProvider).inner).toBeInstanceOf(GeminiImageProvider);
  });

  it("mixes per provider", () => {
    const p = createProviders({ ...LIVE, MUSIC_PROVIDER: "mock", IMAGE_PROVIDER: "mock" });
    expect(p.lyrics).toBeInstanceOf(OpenAiLyricsProvider);
    expect(p.music).toBeInstanceOf(MockMusicProvider);
    expect(p.tts).toBeInstanceOf(MockTtsProvider);
  });

  it("refuses a live provider without its key/model", () => {
    expect(() => createProviders({ ...MOCK, LYRICS_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });
});

// --- Generic error mapping ---------------------------------------------------------------------

describe("toProviderError", () => {
  it.each([
    ["5xx", { status: 503 }, "PROVIDER_UNAVAILABLE", true],
    ["408", { status: 408 }, "PROVIDER_UNAVAILABLE", true],
    ["network (code)", Object.assign(new Error("socket"), { code: "ECONNRESET" }), "PROVIDER_UNAVAILABLE", true],
    ["fetch failed", new TypeError("fetch failed"), "PROVIDER_UNAVAILABLE", true],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "PROVIDER_UNAVAILABLE", true],
    ["unknown non-HTTP", new Error("weird"), "PROVIDER_UNAVAILABLE", false],
    ["bad key", { status: 401, message: "invalid api key" }, "PROVIDER_UNAVAILABLE", false],
    ["429 rate limit", { status: 429, message: "slow down" }, "PROVIDER_QUOTA", true],
    ["402", { status: 402 }, "PROVIDER_QUOTA", false],
    ["400 validation", { status: 400, message: "bad field" }, "PROVIDER_REJECTED", false],
    ["422", { statusCode: 422 }, "PROVIDER_REJECTED", false],
  ] as const)("%s → %s (transient=%s)", (_label, err, code, transient) => {
    const e = toProviderError("openai", err);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ code, transient, vendor: "openai" });
  });

  it("never copies the vendor message (it may echo a child's name)", () => {
    const e = toProviderError("gemini", { status: 400, message: "prompt mentions Mia" });
    expect(e.message).not.toContain("Mia");
  });
});

// --- OpenAI ------------------------------------------------------------------------------------

function fakeOpenAi(impl: (body: Record<string, unknown>) => unknown) {
  const create = vi.fn(async (body: Record<string, unknown>) => impl(body));
  return { client: { responses: { create } } as unknown as Pick<OpenAI, "responses">, create };
}
const textResponse = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], output_text: text });
const writeInput = { topic: "ducks", mood: "playful", ageBand: "3-5", lengthSec: 90 } as const;
const checkInput = { title: "t", lyrics: ["a"], imagePrompt: "a duck", ageBand: "1-2" as const, mood: "playful" as const };

describe("OpenAiLyricsProvider", () => {
  it("write and check are separate calls with separate system prompts and strict JSON schemas", async () => {
    const { client, create } = fakeOpenAi((body) =>
      textResponse(JSON.stringify((body.text as { format: { name: string } }).format.name === "song_draft" ? VALID_DRAFT : { pass: true, reasons: [] })),
    );
    const p = new OpenAiLyricsProvider({ apiKey: "x", model: "model-from-env", client });
    await expect(p.write(writeInput)).resolves.toEqual(VALID_DRAFT);
    await expect(p.check(checkInput)).resolves.toEqual({ pass: true, reasons: [] });

    expect(create).toHaveBeenCalledTimes(2);
    const [w, c] = create.mock.calls.map((call) => call[0] as { model: string; input: { role: string; content: string }[]; text: { format: Record<string, unknown> } });
    expect(w?.model).toBe("model-from-env");
    expect(w?.input[0]?.content).toBe(writeSystemPrompt("3-5", "playful"));
    expect(c?.input[0]?.content).toBe(safetySystemPrompt("playful"));
    expect(w?.input[0]?.content).not.toBe(c?.input[0]?.content);
    expect(w?.text.format).toMatchObject({ type: "json_schema", name: "song_draft", strict: true });
    expect(c?.text.format).toMatchObject({ type: "json_schema", name: "safety_result", strict: true });
  });

  it("check: invalid JSON → fail", async () => {
    const { client } = fakeOpenAi(() => textResponse("not json {"));
    await expect(new OpenAiLyricsProvider({ apiKey: "x", model: "m", client }).check(checkInput)).resolves.toEqual(INVALID_SAFETY_RESPONSE);
  });

  it("check: refusal → fail", async () => {
    const { client } = fakeOpenAi(() => ({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "" }));
    await expect(new OpenAiLyricsProvider({ apiKey: "x", model: "m", client }).check(checkInput)).resolves.toEqual(INVALID_SAFETY_RESPONSE);
  });

  it("write: invalid output → transient PROVIDER_UNAVAILABLE; refusal → PROVIDER_REJECTED", async () => {
    const bad = fakeOpenAi(() => textResponse('{"title": 1}'));
    await expect(new OpenAiLyricsProvider({ apiKey: "x", model: "m", client: bad.client }).write(writeInput)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", transient: true });
    const refused = fakeOpenAi(() => ({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "" }));
    await expect(new OpenAiLyricsProvider({ apiKey: "x", model: "m", client: refused.client }).write(writeInput)).rejects.toMatchObject({ code: "PROVIDER_REJECTED", transient: false });
  });

  it.each([
    ["RateLimitError", () => new RateLimitError(429, { message: "rate" }, "rate limited", new Headers()), "PROVIDER_QUOTA", true],
    ["insufficient_quota", () => new RateLimitError(429, { code: "insufficient_quota" }, "You exceeded your current quota", new Headers()), "PROVIDER_QUOTA", false],
    ["500", () => APIError.generate(500, { message: "boom" }, "boom", new Headers()), "PROVIDER_UNAVAILABLE", true],
    ["timeout", () => new APIConnectionTimeoutError(), "PROVIDER_UNAVAILABLE", true],
    ["400", () => APIError.generate(400, { message: "invalid schema" }, "invalid schema", new Headers()), "PROVIDER_REJECTED", false],
  ] as const)("maps SDK %s → %s", async (_label, makeErr, code, transient) => {
    const { client } = fakeOpenAi(() => {
      throw makeErr();
    });
    const p = new OpenAiLyricsProvider({ apiKey: "x", model: "m", client });
    await expect(p.check(checkInput)).rejects.toMatchObject({ code, transient, vendor: "openai" });
    await expect(p.write(writeInput)).rejects.toMatchObject({ code, transient });
  });
});

// --- Lyrics rules / Zod parsing ----------------------------------------------------------------

describe("lyrics rules", () => {
  it("system prompt covers every R1 rule", () => {
    const sys = writeSystemPrompt("1-2", "lullaby");
    for (const needle of ["60 seconds", "Original lyrics only", "nursery rhymes", "villains", "punishment", "body shaming", "climbing high", "hot things", "in the mouth", "wandering off", "medicine", "sleep imagery", "never describe a human child"]) {
      expect(sys).toContain(needle);
    }
    expect(writeSystemPrompt("3-5", "playful")).toContain("120 seconds");
    for (const needle of ["villains", "climbing high", "medicine", "image prompt"]) expect(safetySystemPrompt("calm")).toContain(needle);
  });

  it("safety prompt applies the lullaby rule only when mood is lullaby; check input carries mood", () => {
    expect(safetySystemPrompt("lullaby")).toContain("mood is LULLABY: apply rule 5 strictly");
    for (const mood of ["playful", "calm"] as const) {
      expect(safetySystemPrompt(mood)).toContain("rule 5 does not apply");
      expect(safetySystemPrompt(mood)).not.toContain("apply rule 5 strictly");
    }
    expect(safetySystemPrompt("playful")).not.toContain("You are not told the song's mood");
    expect(JSON.parse(checkUserPrompt({ ...checkInput, mood: "lullaby" }))).toMatchObject({ mood: "lullaby" });
  });

  it("write prompt includes previous safety reasons as feedback", () => {
    expect(writeUserPrompt({ topic: "x", ageBand: "3-5", lengthSec: 60 })).not.toContain("FAILED");
    const prompt = writeUserPrompt({ topic: "x", ageBand: "3-5", lengthSec: 60, feedback: ["rule 3: models climbing high"] });
    expect(prompt).toContain("FAILED the independent safety review");
    expect(prompt).toContain("- rule 3: models climbing high");
  });

  it("caps length: 60 s for 1–2, 120 s for 3–5", () => {
    expect(effectiveLengthSec("1-2", 120)).toBe(60);
    expect(effectiveLengthSec("3-5", 120)).toBe(120);
    expect(writeUserPrompt({ topic: "x", ageBand: "1-2", lengthSec: 120 })).toContain("about 60 seconds");
  });

  it("parseLyricsDraft: valid / invalid JSON / wrong shape / name leaked into image prompt", () => {
    expect(parseLyricsDraft(JSON.stringify(VALID_DRAFT))).toEqual(VALID_DRAFT);
    expect(parseLyricsDraft("{oops")).toBeNull();
    expect(parseLyricsDraft(JSON.stringify({ ...VALID_DRAFT, lyrics: "one line" }))).toBeNull();
    expect(parseLyricsDraft(JSON.stringify({ ...VALID_DRAFT, imagePrompt: "Mia hugging an owl" }), "Mia")).toBeNull();
    expect(parseLyricsDraft(JSON.stringify(VALID_DRAFT), "Mia")).toEqual(VALID_DRAFT);
  });

  it("parseSafetyResult: invalid JSON or shape → fail; contradictions → fail", () => {
    expect(parseSafetyResult('{"pass":true,"reasons":[]}')).toEqual({ pass: true, reasons: [] });
    expect(parseSafetyResult('{"pass":false,"reasons":["rule 2"]}')).toEqual({ pass: false, reasons: ["rule 2"] });
    expect(parseSafetyResult("")).toEqual(INVALID_SAFETY_RESPONSE);
    expect(parseSafetyResult("pass")).toEqual(INVALID_SAFETY_RESPONSE);
    expect(parseSafetyResult('{"pass":"yes","reasons":[]}')).toEqual(INVALID_SAFETY_RESPONSE);
    expect(parseSafetyResult('{"pass":true}')).toEqual(INVALID_SAFETY_RESPONSE);
    expect(parseSafetyResult('{"pass":false,"reasons":[]}').pass).toBe(false);
    expect(parseSafetyResult('{"pass":true,"reasons":["scary"]}')).toEqual({ pass: false, reasons: ["scary"] });
  });
});

// --- ElevenLabs --------------------------------------------------------------------------------

describe("ElevenLabs adapters", () => {
  it("music: composition_plan of text chunks whose durations sum to lengthSec; model from env; mp3", async () => {
    const compose = vi.fn(async () => stream(Buffer.from("mp3")));
    const client = { music: { compose } } as unknown as ConstructorParameters<typeof ElevenLabsMusicProvider>[0]["client"];
    const lyrics = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const out = await new ElevenLabsMusicProvider({ apiKey: "x", model: "music-from-env", client }).compose({ lyrics, prompt: "ukulele, 100 bpm", lengthSec: 90 });

    expect(out.toString()).toBe("mp3");
    const [body, opts] = compose.mock.calls[0] as unknown as [Record<string, unknown> & { compositionPlan: { chunks: { text: string; durationMs: number; positiveStyles: string[] }[] } }, Record<string, unknown>];
    expect(body.modelId).toBe("music-from-env");
    expect(body.outputFormat).toBe("mp3_44100_192");
    expect(body.prompt).toBeUndefined(); // prompt and composition_plan are mutually exclusive
    expect(opts).toMatchObject({ timeoutInSeconds: expect.any(Number), maxRetries: 0 });
    const chunks = body.compositionPlan.chunks;
    expect(chunks.reduce((s, c) => s + c.durationMs, 0)).toBe(90_000);
    for (const c of chunks) {
      expect(c.durationMs).toBeGreaterThanOrEqual(3000);
      expect(c.durationMs).toBeLessThanOrEqual(120_000);
      expect(c.text.split("\n").length).toBeLessThanOrEqual(30);
    }
    expect(chunks.map((c) => c.text).join("\n")).toContain("line 20");
    expect(chunks[0]?.positiveStyles).toEqual(expect.arrayContaining(["ukulele", "100 bpm"]));
  });

  it("music plan: single short song fits one chunk", () => {
    const plan = buildCompositionPlan({ lyrics: ["a", "b", "c"], prompt: "soft", lengthSec: 60 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toMatchObject({ durationMs: 60_000 });
  });

  it("tts: convert(voiceId, { text, modelId, outputFormat: mp3 })", async () => {
    const convert = vi.fn(async () => stream(Buffer.from("voice")));
    const client = { textToSpeech: { convert } } as unknown as ConstructorParameters<typeof ElevenLabsTtsProvider>[0]["client"];
    const out = await new ElevenLabsTtsProvider({ apiKey: "x", model: "tts-from-env", voiceId: "voice-1", client }).speak({ text: "ZOH-ee" });
    expect(out.toString()).toBe("voice");
    expect(convert).toHaveBeenCalledWith("voice-1", { text: "ZOH-ee", modelId: "tts-from-env", outputFormat: "mp3_44100_128" }, expect.objectContaining({ maxRetries: 0 }));
  });

  it.each([
    ["401 quota_exceeded", () => new ElevenLabsError({ message: "Status code: 401", statusCode: 401, body: { detail: { status: "quota_exceeded" } } }), "PROVIDER_QUOTA", false],
    ["429 busy", () => new ElevenLabsError({ message: "Status code: 429", statusCode: 429, body: { detail: { status: "system_busy" } } }), "PROVIDER_QUOTA", true],
    ["422 validation", () => new ElevenLabsError({ message: "Status code: 422", statusCode: 422, body: { detail: [{ msg: "field required" }] } }), "PROVIDER_REJECTED", false],
    ["400 bad_prompt", () => new ElevenLabsError({ message: "Status code: 400", statusCode: 400, body: { detail: { status: "bad_prompt" } } }), "PROVIDER_REJECTED", false],
    ["500", () => new ElevenLabsError({ message: "Status code: 500", statusCode: 500 }), "PROVIDER_UNAVAILABLE", true],
    ["timeout", () => new ElevenLabsTimeoutError("Timeout exceeded when calling POST /v1/music."), "PROVIDER_UNAVAILABLE", true],
  ] as const)("maps SDK %s → %s", async (_label, makeErr, code, transient) => {
    const fail = vi.fn(async () => {
      throw makeErr();
    });
    const music = new ElevenLabsMusicProvider({ apiKey: "x", model: "m", client: { music: { compose: fail } } as never });
    const tts = new ElevenLabsTtsProvider({ apiKey: "x", model: "m", voiceId: "v", client: { textToSpeech: { convert: fail } } as never });
    await expect(music.compose({ lyrics: ["a"], prompt: "p", lengthSec: 60 })).rejects.toMatchObject({ code, transient, vendor: "elevenlabs" });
    await expect(tts.speak({ text: "Mia" })).rejects.toMatchObject({ code, transient, vendor: "elevenlabs" });
  });
});

// --- Gemini ------------------------------------------------------------------------------------

describe("GeminiImageProvider", () => {
  const make = (impl: (body: Record<string, unknown>) => unknown) => {
    const create = vi.fn(async (body: Record<string, unknown>, _opts?: unknown) => impl(body));
    return { p: new GeminiImageProvider({ apiKey: "x", model: "image-from-env", client: { interactions: { create } } as never }), create };
  };

  it("requests a square image (JPEG: the only mime type the model accepts) with the env model", async () => {
    const { p, create } = make(() => ({ output_image: { type: "image", data: PNG.toString("base64"), mime_type: "image/png" } }));
    await expect(p.generate({ prompt: "an owl" })).resolves.toEqual(PNG);
    expect(create).toHaveBeenCalledWith(
      { model: "image-from-env", input: "an owl", response_format: expect.objectContaining({ type: "image", aspect_ratio: "1:1", mime_type: "image/jpeg" }) },
      expect.objectContaining({ timeout_ms: expect.any(Number) }),
    );
  });

  it("re-encodes a JPEG response to PNG", async () => {
    const jpeg = await runFfmpeg(["-f", "lavfi", "-i", "color=c=pink:s=16x16:d=1", "-frames:v", "1", "-f", "mjpeg", "pipe:1"], Buffer.alloc(0));
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const { p } = make(() => ({ output_image: { type: "image", data: jpeg.toString("base64"), mime_type: "image/jpeg" } }));
    const png = await p.generate({ prompt: "x" });
    expect(png.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
  });

  it("no image back (safety block) → PROVIDER_REJECTED; unknown format → transient", async () => {
    await expect(make(() => ({ output_text: "I can't" })).p.generate({ prompt: "x" })).rejects.toMatchObject({ code: "PROVIDER_REJECTED", transient: false });
    await expect(make(() => ({ output_image: { data: Buffer.from("GIF89a").toString("base64") } })).p.generate({ prompt: "x" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", transient: true });
  });

  it.each([
    ["429 RESOURCE_EXHAUSTED", () => new GeminiApiError({ message: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', status: 429 }), "PROVIDER_QUOTA", false],
    ["429 interactions error", () => Object.assign(new Error("Too many requests"), { name: "CreateInteractionClientError", statusCode: 429 }), "PROVIDER_QUOTA", true],
    ["400 safety", () => Object.assign(new Error("blocked by safety"), { name: "CreateInteractionClientError", statusCode: 400 }), "PROVIDER_REJECTED", false],
    ["503", () => Object.assign(new Error("unavailable"), { name: "CreateInteractionServerError", statusCode: 503 }), "PROVIDER_UNAVAILABLE", true],
    ["timeout", () => Object.assign(new Error("timed out"), { name: "RequestTimeoutError" }), "PROVIDER_UNAVAILABLE", true],
  ] as const)("maps SDK %s → %s", async (_label, makeErr, code, transient) => {
    const { p } = make(() => {
      throw makeErr();
    });
    await expect(p.generate({ prompt: "x" })).rejects.toMatchObject({ code, transient, vendor: "gemini" });
  });
});

// --- STYLE_PROMPT + mocks ----------------------------------------------------------------------

describe("image style", () => {
  it("prepends STYLE_PROMPT (PROJECT.md §10 verbatim) to every image prompt", async () => {
    expect(STYLE_PROMPT).toBe(
      "Soft, rounded children's picture-book illustration. Flat pastel colors, thick friendly outlines, simple shapes, gentle lighting, plain background. Cute animal or object characters with big eyes. No text, no letters, no logos, no real people, no existing cartoon characters. Square composition.",
    );
    const generate = vi.fn(async () => PNG);
    await new StyledImageProvider({ generate }).generate({ prompt: "an owl" });
    expect(generate).toHaveBeenCalledWith({ prompt: `${STYLE_PROMPT}\n\nan owl` });
  });
});

describe("mock providers", () => {
  it("return fixtures: lyrics with the name filled in, mp3 audio, PNG cover", async () => {
    const p = createProviders(MOCK);
    const draft = await p.lyrics.write({ topic: "ducks", mood: "playful", ageBand: "3-5", lengthSec: 60, childName: "Mia" });
    expect(draft.lyrics.join(" ")).toContain("Mia");
    expect(draft.imagePrompt).not.toContain("Mia");
    await expect(p.lyrics.check({ ...draft, ageBand: "3-5", mood: "playful" })).resolves.toEqual({ pass: true, reasons: [] });
    const mp3 = await p.music.compose({ lyrics: draft.lyrics, prompt: draft.musicPrompt, lengthSec: 60 });
    expect(mp3.subarray(0, 3).toString("latin1") === "ID3" || (mp3[0] === 0xff && ((mp3[1] ?? 0) & 0xe0) === 0xe0)).toBe(true);
    expect((await p.tts.speak({ text: "Mia" })).length).toBeGreaterThan(0);
    expect((await p.image.generate({ prompt: "x" })).subarray(0, 4)).toEqual(PNG.subarray(0, 4));
  });

  it('topic containing "[unsafe]" makes check fail (regen/reject path)', async () => {
    const p = createProviders(MOCK);
    const draft = await p.lyrics.write({ topic: "ducks [unsafe]", mood: "calm", ageBand: "1-2", lengthSec: 60 });
    const res = await p.lyrics.check({ ...draft, ageBand: "1-2", mood: "calm" });
    expect(res.pass).toBe(false);
    expect(res.reasons.length).toBeGreaterThan(0);
  });
});

describe("generic-song safety rule 7 (R1: generic songs are shared with every family)", () => {
  it("the check prompt adds rule 7 for generic songs only", () => {
    for (const needle of ["GENERIC song", "rule 7: personal detail", "no person's name", "specific real place"]) {
      expect(safetySystemPrompt("calm")).toContain(needle);
    }
    expect(safetySystemPrompt("calm", true)).not.toContain("GENERIC song");
    expect(writeUserPrompt({ topic: "x", ageBand: "3-5", lengthSec: 60 })).toContain("no real place");
  });

  it("OpenAI check sends the personalized flag through to the system prompt", async () => {
    const { client, create } = fakeOpenAi(() => textResponse(JSON.stringify({ pass: true, reasons: [] })));
    const p = new OpenAiLyricsProvider({ apiKey: "x", model: "m", client });
    await p.check({ ...checkInput, personalized: true });
    await p.check(checkInput);
    const prompts = create.mock.calls.map((c) => (c[0] as { input: { content: string }[] }).input[0]?.content);
    expect(prompts).toEqual([safetySystemPrompt("playful", true), safetySystemPrompt("playful", false)]);
  });

  it('mock: "[personal]" in the topic fails a generic song with a clear reason, passes a personalized one', async () => {
    const p = createProviders(MOCK);
    const draft = await p.lyrics.write({ topic: "visiting [personal]", mood: "calm", ageBand: "3-5", lengthSec: 60 });
    const generic = await p.lyrics.check({ ...draft, ageBand: "3-5", mood: "calm" });
    expect(generic).toEqual({ pass: false, reasons: [expect.stringContaining("rule 7: personal detail")] });
    await expect(p.lyrics.check({ ...draft, ageBand: "3-5", mood: "calm", personalized: true })).resolves.toEqual({ pass: true, reasons: [] });
  });
});

// Worker pipeline end-to-end: fakeDb + in-memory S3 + mock providers + REAL ffmpeg mixing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";
import { createMemoryStorage } from "./helpers/memoryStorage.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));
const storage = createMemoryStorage();
vi.mock("../src/lib/storage.js", async (importActual) => ({ ...(await importActual<object>()), ...storage.module }));

const { default: app } = await import("../src/app.js");
const { runNextJob } = await import("../src/worker/index.js");
const { resetStaleLocks } = await import("../src/models/jobs.model.js");
const { getProviders } = await import("../src/providers/index.js");
const { ProviderError } = await import("../src/providers/errors.js");
const { songGenerationLimiter } = await import("../src/middleware/rateLimit.js");
const { STYLE_PROMPT, StyledImageProvider } = await import("../src/providers/image.js");

vi.setConfig({ testTimeout: 60_000 });

const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const auth = (u = ALICE) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});
const MIA = "c1111111-1111-4111-8111-111111111111";

const providers = getProviders();
const makeSpies = () => ({
  write: vi.spyOn(providers.lyrics, "write"),
  check: vi.spyOn(providers.lyrics, "check"),
  compose: vi.spyOn(providers.music, "compose"),
  generate: vi.spyOn(providers.image, "generate"),
});
let spies: ReturnType<typeof makeSpies>;

async function createSong(body: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post("/api/songs")
    .set(auth())
    .send({ topic: "ducks", mood: "playful", lengthSec: 60, ageBand: "3-5", ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Runs the queue until nothing is runnable now. */
async function drain(): Promise<number> {
  let n = 0;
  while (await runNextJob()) n++;
  return n;
}

const songRow = (id: string) => fake.state.songs.find((s) => s.id === id) as Record<string, unknown>;
const jobsOf = (id: string) => fake.state.jobs.filter((j) => j.song_id === id);
const getSong = async (id: string) => (await request(app).get(`/api/songs/${id}`).set(auth())).body.data;
const clearSpies = () => Object.values(spies).forEach((s) => s.mockClear());

beforeEach(async () => {
  fake.reset();
  await songGenerationLimiter.resetKey(`user:${ALICE.id}`); // these tests create many songs as Alice
  storage.reset();
  fake.state.children.push({ id: MIA, user_id: ALICE.id, display_name: "Mia", phonetic_name: "MEE-ah", age_band: "3-5", created_at: new Date() });
  spies = makeSpies();
});

afterEach(() => {
  Object.values(spies).forEach((s) => s.mockRestore());
});

describe("worker: happy path", () => {
  it("runs writing → checking → composing → illustrating → mixing to pending_review (never ready)", async () => {
    const id = await createSong({ mood: "lullaby" });
    expect(await drain()).toBe(1);

    const row = songRow(id);
    expect(row.status).toBe("pending_review");
    expect(row.approved_at).toBeNull();
    const prefix = `songs/${ALICE.id}/${id}/`;
    expect(row.raw_audio_key).toMatch(new RegExp(`^${prefix}raw-\\d+\\.mp3$`));
    expect(row.image_key).toMatch(new RegExp(`^${prefix}image-\\d+\\.png$`));
    expect(row.audio_key).toMatch(new RegExp(`^${prefix}audio-\\d+\\.mp3$`));
    expect(Number(row.duration_ms)).toBeGreaterThan(2500);
    expect(Number(row.duration_ms)).toBeLessThan(3500);

    // The normalized MP3 is a real re-encode, never the raw provider bytes (R3).
    const raw = storage.objects.get(row.raw_audio_key as string)?.body;
    const mixed = storage.objects.get(row.audio_key as string);
    expect(mixed?.contentType).toBe("audio/mpeg");
    expect(mixed?.body.equals(raw as Buffer)).toBe(false);
    expect(storage.objects.get(row.image_key as string)?.contentType).toBe("image/png");

    expect(spies.check).toHaveBeenCalledWith(expect.objectContaining({ mood: "lullaby", ageBand: "3-5" }));
    expect(spies.compose).toHaveBeenCalledWith(expect.objectContaining({ lengthSec: 60 }));
    expect(jobsOf(id)).toEqual([expect.objectContaining({ done_at: expect.any(Date), locked_at: null, attempts: 0 })]);

    const song = await getSong(id);
    expect(song).toMatchObject({ status: "pending_review", title: "Little Duck Says Hello", safety: { pass: true, reasons: [] }, error: null });
    expect(song.lyrics).toContain("Hello, little one, the duck says hi");
    expect(song.audioUrl).toMatch(/^\/api\/media\/.+\/audio\?v=[0-9a-f]{8}$/);
  });

  it("personalized: lyrics use phoneticName; the image prompt never contains the child's name (R2/R4)", async () => {
    const id = await createSong({ childId: MIA });
    await drain();
    expect(songRow(id).status).toBe("pending_review");
    expect(spies.write).toHaveBeenCalledWith(expect.objectContaining({ childName: "MEE-ah" }));
    expect(spies.generate.mock.calls[0]?.[0].prompt).not.toMatch(/mia|mee-ah/i);
    // What actually reaches the image model: STYLE_PROMPT + prompt, still name-free.
    const inner = vi.spyOn((providers.image as InstanceType<typeof StyledImageProvider>).inner, "generate");
    clearSpies();
    await request(app).post(`/api/songs/${id}/regenerate`).set(auth()).send({ part: "image" });
    await drain();
    const sent = inner.mock.calls[0]?.[0].prompt ?? "";
    inner.mockRestore();
    expect(sent.startsWith(STYLE_PROMPT)).toBe(true);
    expect(sent).not.toMatch(/mia|mee-ah/i);
  });

  it("a draft that puts the child's name in the image prompt is never illustrated", async () => {
    spies.write.mockResolvedValue({ title: "Owl Night", lyrics: ["hoot", "hoot"], musicPrompt: "soft", imagePrompt: "Mia hugging an owl" });
    const id = await createSong({ childId: MIA });
    for (let i = 0; i < 3; i++) {
      await drain();
      fake.advance(10 * 60_000);
    }
    expect(spies.generate).not.toHaveBeenCalled();
    expect(songRow(id).status).toBe("failed");
    expect(String(songRow(id).error)).not.toMatch(/mia/i);
  });
});

describe("worker: safety loop (R1)", () => {
  it("[unsafe] → rewritten twice with the check's reasons as feedback, then rejected", async () => {
    const id = await createSong({ topic: "ducks [unsafe]" });
    await drain();

    expect(spies.write).toHaveBeenCalledTimes(3);
    expect(spies.write.mock.calls[0]?.[0].feedback).toBeUndefined();
    expect(spies.write.mock.calls[1]?.[0].feedback).toEqual(["mock: unsafe marker present"]);
    expect(spies.write.mock.calls[2]?.[0].feedback).toEqual(["mock: unsafe marker present"]);
    expect(spies.check).toHaveBeenCalledTimes(3);
    expect(spies.compose).not.toHaveBeenCalled();
    expect(spies.generate).not.toHaveBeenCalled();

    const song = await getSong(id);
    expect(song).toMatchObject({ status: "rejected", safety: { pass: false, reasons: ["mock: unsafe marker present"] }, audioUrl: null });
    expect(jobsOf(id)).toEqual([expect.objectContaining({ done_at: expect.any(Date), safety_regens: 2 })]);
    expect(storage.module.putObject).not.toHaveBeenCalled();
  });

  it("a rewrite that passes continues the pipeline", async () => {
    spies.check.mockResolvedValueOnce({ pass: false, reasons: ["rule 2: scary"] });
    const id = await createSong();
    await drain();
    expect(spies.write).toHaveBeenCalledTimes(2);
    expect(spies.write.mock.calls[1]?.[0].feedback).toEqual(["rule 2: scary"]);
    expect(songRow(id).status).toBe("pending_review");
    expect(jobsOf(id)[0]?.safety_regens).toBe(1);
  });
});

describe("worker: retries", () => {
  it("transient error → attempts++, backoff, unlocked; then succeeds and attempts reset", async () => {
    spies.compose.mockRejectedValueOnce(new ProviderError("elevenlabs", "PROVIDER_UNAVAILABLE", true));
    const id = await createSong();
    await drain();

    const job = jobsOf(id)[0] as Record<string, unknown>;
    expect(songRow(id).status).toBe("composing");
    expect(job).toMatchObject({ step: "composing", attempts: 1, locked_at: null, done_at: null });
    expect(String(job.last_error)).toContain("PROVIDER_UNAVAILABLE");
    expect((job.run_after as Date).getTime() - fake.peekNow().getTime()).toBeGreaterThan(5_000); // 2^1 × 5 s

    expect(await drain()).toBe(0); // still backing off
    fake.advance(60_000);
    expect(await drain()).toBe(1);
    expect(songRow(id).status).toBe("pending_review");
    expect(jobsOf(id)[0]).toMatchObject({ attempts: 0, done_at: expect.any(Date) });
    expect(spies.write).toHaveBeenCalledTimes(1); // earlier steps were not redone
  });

  it("transient errors up to WORKER_MAX_ATTEMPTS → failed with a generic error", async () => {
    spies.compose.mockRejectedValue(new ProviderError("elevenlabs", "PROVIDER_UNAVAILABLE", true));
    const id = await createSong();
    for (let i = 0; i < 5; i++) {
      await drain();
      fake.advance(10 * 60_000);
    }
    expect(spies.compose).toHaveBeenCalledTimes(3);
    expect(jobsOf(id)[0]).toMatchObject({ attempts: 3, done_at: expect.any(Date) });
    const song = await getSong(id);
    expect(song).toMatchObject({ status: "failed", error: expect.stringMatching(/unavailable/i) });
  });

  it("non-transient error → failed at once, generic name-free error", async () => {
    spies.generate.mockRejectedValue(new ProviderError("gemini", "PROVIDER_REJECTED", false));
    const id = await createSong({ childId: MIA });
    await drain();
    expect(spies.generate).toHaveBeenCalledTimes(1);
    const song = await getSong(id);
    expect(song.status).toBe("failed");
    expect(song.error).toMatch(/declined/i);
    expect(song.error).not.toMatch(/mia|mee-ah/i);
    expect(jobsOf(id)[0]).toMatchObject({ done_at: expect.any(Date), attempts: 1 });
  });

  it("S3 AccessDenied (4xx) → failed at once, no pointless retries; S3 5xx is retried", async () => {
    const s3Err = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    storage.module.putObject.mockRejectedValueOnce(s3Err("InternalError", 500));
    storage.module.putObject.mockRejectedValueOnce(s3Err("AccessDenied", 403));
    const id = await createSong();
    await drain();
    expect(jobsOf(id)[0]).toMatchObject({ attempts: 1, done_at: null });
    fake.advance(60_000);
    await drain();
    expect(jobsOf(id)[0]).toMatchObject({ attempts: 2, done_at: expect.any(Date) });
    expect(String(jobsOf(id)[0]?.last_error)).toContain("AccessDenied");
    expect(await getSong(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/something went wrong/i) });
  });

  it("boot: stale locks (>10 min, not done) are released and mid-step songs go back to queued", async () => {
    const stale = await createSong();
    const fresh = await createSong();
    const [js, jf] = [jobsOf(stale)[0], jobsOf(fresh)[0]] as Record<string, unknown>[];
    Object.assign(js!, { locked_at: new Date(fake.peekNow().getTime() - 11 * 60_000) });
    Object.assign(jf!, { locked_at: new Date(fake.peekNow().getTime() - 2 * 60_000) });
    songRow(stale).status = "composing";
    songRow(fresh).status = "writing";

    expect(await resetStaleLocks()).toBe(1);
    expect(js!.locked_at).toBeNull();
    expect(songRow(stale).status).toBe("queued");
    expect(jf!.locked_at).not.toBeNull();
    expect(songRow(fresh).status).toBe("writing");

    expect(await drain()).toBe(1); // only the released job is runnable
    expect(songRow(stale).status).toBe("pending_review");
  });
});

describe("regenerate re-runs only the right steps", () => {
  // Personalized: a ready generic song is shared and can't be regenerated (sharing rules).
  async function readySong(): Promise<{ id: string; before: Record<string, unknown> }> {
    const id = await createSong({ childId: MIA });
    await drain();
    expect((await request(app).post(`/api/songs/${id}/approve`).set(auth())).status).toBe(200);
    clearSpies();
    storage.module.deleteObjects.mockClear();
    return { id, before: { ...songRow(id) } };
  }

  it("image → illustrating only; old cover deleted; audio untouched", async () => {
    const { id, before } = await readySong();
    expect((await request(app).post(`/api/songs/${id}/regenerate`).set(auth()).send({ part: "image" })).status).toBe(200);
    await drain();
    const after = songRow(id);
    expect(spies.generate).toHaveBeenCalledTimes(1);
    for (const s of [spies.write, spies.check, spies.compose]) expect(s).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: "pending_review", approved_at: null, audio_key: before.audio_key, raw_audio_key: before.raw_audio_key });
    expect(after.image_key).not.toBe(before.image_key);
    expect(storage.objects.has(before.image_key as string)).toBe(false);
    expect(storage.objects.has(after.image_key as string)).toBe(true);
  });

  it("music → composing + mixing; new keys, superseded audio deleted; lyrics and image untouched", async () => {
    const { id, before } = await readySong();
    const oldUrl = (await getSong(id)).audioUrl;
    await request(app).post(`/api/songs/${id}/regenerate`).set(auth()).send({ part: "music" });
    await drain();
    const after = songRow(id);
    expect(spies.compose).toHaveBeenCalledTimes(1);
    for (const s of [spies.write, spies.check, spies.generate]) expect(s).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: "pending_review", image_key: before.image_key, lyrics: before.lyrics });
    expect(after.raw_audio_key).not.toBe(before.raw_audio_key);
    expect(after.audio_key).not.toBe(before.audio_key);
    expect(storage.objects.has(before.audio_key as string)).toBe(false);
    expect(storage.objects.has(before.raw_audio_key as string)).toBe(false);
    expect((await getSong(id)).audioUrl).not.toBe(oldUrl); // new v
  });

  it("lyrics → writing + checking + composing + mixing; cover and its prompt kept", async () => {
    const { id, before } = await readySong();
    await request(app).post(`/api/songs/${id}/regenerate`).set(auth()).send({ part: "lyrics" });
    await drain();
    const after = songRow(id);
    expect(spies.write).toHaveBeenCalledTimes(1);
    expect(spies.check).toHaveBeenCalledTimes(1);
    expect(spies.compose).toHaveBeenCalledTimes(1);
    expect(spies.generate).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: "pending_review", image_key: before.image_key, image_prompt: before.image_prompt });
    expect(after.audio_key).not.toBe(before.audio_key);
  });
});

describe("library + media", () => {
  it("library never returns non-ready songs; approve makes it appear", async () => {
    const id = await createSong();
    await drain();
    const lib = () => request(app).get("/api/library").set(auth());
    expect((await lib()).body).toEqual({ data: [], error: null, meta: { total: 0 } });

    await request(app).post(`/api/songs/${id}/approve`).set(auth());
    const res = await lib();
    expect(res.body.data).toEqual([
      { id, childId: null, title: "Little Duck Says Hello", mood: "playful", audioUrl: expect.stringContaining(`/api/media/${id}/audio?v=`), imageUrl: expect.stringContaining(`/api/media/${id}/image?v=`), durationMs: expect.any(Number) },
    ]);
  });

  it("media: owner gets audio (pending_review preview) with cache + range headers; Range → 206", async () => {
    const id = await createSong();
    await drain();
    const audioKey = songRow(id).audio_key as string;
    const size = storage.objects.get(audioKey)?.body.length ?? 0;

    const full = await request(app).get(`/api/media/${id}/audio?v=whatever`).set(auth()).buffer(true);
    expect(full.status).toBe(200);
    expect(full.headers).toMatchObject({
      "content-type": "audio/mpeg",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(size),
    });
    expect(storage.module.getObjectStream).toHaveBeenLastCalledWith(audioKey, undefined); // audio_key, never raw

    const part = await request(app).get(`/api/media/${id}/audio`).set(auth()).set("Range", "bytes=0-99").buffer(true);
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${size}`);
    expect(part.headers["content-length"]).toBe("100");

    const img = await request(app).get(`/api/media/${id}/image`).set(auth()).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");

    const bad = await request(app).get(`/api/media/${id}/audio`).set(auth()).set("Range", `bytes=${size + 10}-`);
    expect(bad.status).toBe(416);
  });

  it("media: 404 for another user, non-ready/non-review songs, unknown ids; 401 without token", async () => {
    const id = await createSong();
    await drain();
    expect((await request(app).get(`/api/media/${id}/audio`).set(auth(BOB))).status).toBe(404);
    expect((await request(app).get(`/api/media/${id}/audio`)).status).toBe(401);
    expect((await request(app).get("/api/media/nope/audio").set(auth())).status).toBe(404);
    for (const status of ["rejected", "failed", "mixing", "queued"]) {
      songRow(id).status = status;
      const res = await request(app).get(`/api/media/${id}/image`).set(auth());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ data: null, error: { code: "NOT_FOUND", message: expect.any(String) }, meta: {} });
    }
  });

  it("CORS exposes Content-Range, Accept-Ranges, Content-Length", async () => {
    const res = await request(app).get("/api/health").set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-expose-headers"]).toBe("Content-Range,Accept-Ranges,Content-Length");
  });

  it("library ?childId: generic + that child's ready songs; another user's child → 404", async () => {
    const generic = await createSong();
    const personal = await createSong({ childId: MIA });
    await drain();
    for (const id of [generic, personal]) await request(app).post(`/api/songs/${id}/approve`).set(auth());

    const ids = async (q: string) => ((await request(app).get(`/api/library${q}`).set(auth())).body.data as { id: string }[]).map((s) => s.id).sort();
    expect(await ids("")).toEqual([generic]);
    expect(await ids(`?childId=${MIA}`)).toEqual([generic, personal].sort());
    expect((await request(app).get(`/api/library?childId=${MIA}`).set(auth(BOB))).status).toBe(404);
  });
});

describe("worker: generic-song personal-detail check (R1, shared songs)", () => {
  const PERSONAL_REASON = expect.stringContaining("rule 7: personal detail");

  it("generic [personal] → rewritten twice with the reason as feedback, then rejected", async () => {
    const id = await createSong({ topic: "a trip to [personal]" });
    await drain();
    expect(spies.check).toHaveBeenCalledTimes(3);
    expect(spies.check.mock.calls[0]?.[0]).toMatchObject({ personalized: false });
    expect(spies.write.mock.calls[1]?.[0].feedback).toEqual([PERSONAL_REASON]);
    const song = await getSong(id);
    expect(song).toMatchObject({ status: "rejected", shared: false, safety: { pass: false, reasons: [PERSONAL_REASON] } });
    expect(storage.module.putObject).not.toHaveBeenCalled();
  });

  it("personalized song: the same marker passes (the stricter rule is for generic songs only)", async () => {
    const id = await createSong({ topic: "a trip to [personal]", childId: MIA });
    await drain();
    expect(spies.check.mock.calls[0]?.[0]).toMatchObject({ personalized: true });
    expect(songRow(id).status).toBe("pending_review");
  });
});

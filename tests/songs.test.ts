import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";
import { createMemoryStorage } from "./helpers/memoryStorage.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));
const storage = createMemoryStorage();
vi.mock("../src/lib/storage.js", async (importActual) => ({ ...(await importActual<object>()), ...storage.module }));

const { default: app } = await import("../src/app.js");

const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const auth = (u = ALICE) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});
const TODDLER = "c1111111-1111-4111-8111-111111111111"; // Alice's, 1-2
const BOBS_CHILD = "c3333333-3333-4333-8333-333333333333";

const post = (body: unknown, u = ALICE) => request(app).post("/api/songs").set(auth(u)).send(body as object);
const generic = { topic: "  ducks at the pond  ", mood: "playful", lengthSec: 90, ageBand: "3-5" };

/** Inserts a song row directly (bypassing the API) in any status. */
function seedSong(id: string, over: Record<string, unknown> = {}) {
  const row = {
    id, user_id: ALICE.id, child_id: null, topic: "ducks", mood: "playful", age_band: "3-5", length_sec: 60, status: "pending_review",
    title: "Duck Song", lyrics: JSON.stringify(["quack", "quack"]), music_prompt: "ukulele", image_prompt: "a duck",
    safety_result: JSON.stringify({ pass: true, reasons: [] }), raw_audio_key: `songs/a/${id}/raw-1.mp3`, audio_key: `songs/a/${id}/audio-1.mp3`,
    image_key: `songs/a/${id}/image-1.png`, video_key: null, duration_ms: 60000, error: null, approved_at: null,
    created_at: fake.peekNow(), updated_at: null, ...over,
  };
  fake.state.songs.push(row);
  fake.advance(1000);
  return row;
}

beforeEach(() => {
  fake.reset();
  storage.reset();
  fake.state.children.push(
    { id: TODDLER, user_id: ALICE.id, display_name: "Mia", phonetic_name: "MEE-ah", age_band: "1-2", created_at: new Date() },
    { id: BOBS_CHILD, user_id: BOB.id, display_name: "Max", phonetic_name: null, age_band: "3-5", created_at: new Date() },
  );
});

describe("POST /api/songs", () => {
  it("creates a queued song and its writing job together → 201 { id, status }", async () => {
    const res = await post(generic);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { id: expect.any(String), status: "queued" }, error: null, meta: {} });
    const song = fake.state.songs[0];
    expect(song).toMatchObject({ id: res.body.data.id, user_id: ALICE.id, child_id: null, topic: "ducks at the pond", age_band: "3-5", length_sec: 90, status: "queued" });
    expect(fake.state.jobs).toEqual([expect.objectContaining({ song_id: song?.id, step: "writing", attempts: 0, safety_regens: 0, regen_part: null, done_at: null })]);
  });

  it("takes ageBand from the child (body ageBand ignored)", async () => {
    const res = await post({ topic: "bath time", mood: "calm", lengthSec: 60, childId: TODDLER, ageBand: "3-5" });
    expect(res.status).toBe(201);
    expect(fake.state.songs[0]).toMatchObject({ child_id: TODDLER, age_band: "1-2" });
  });

  it("R1: ages 1-2 are capped at 60 s → 400 VALIDATION (via child or body)", async () => {
    for (const body of [
      { topic: "bath time", mood: "calm", lengthSec: 90, childId: TODDLER },
      { topic: "bath time", mood: "calm", lengthSec: 120, ageBand: "1-2" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ data: null, error: { code: "VALIDATION", message: expect.stringContaining("lengthSec") }, meta: {} });
    }
    expect(fake.state.songs).toHaveLength(0);
    expect(fake.state.jobs).toHaveLength(0);
  });

  it.each([
    ["missing ageBand without childId", { topic: "ducks", mood: "calm", lengthSec: 60 }, "ageBand"],
    ["topic too short", { ...generic, topic: " a " }, "topic"],
    ["topic too long", { ...generic, topic: "x".repeat(121) }, "topic"],
    ["bad mood", { ...generic, mood: "spooky" }, "mood"],
    ["lengthSec not 60|90|120", { ...generic, lengthSec: 75 }, "lengthSec"],
    ["lengthSec as string", { ...generic, lengthSec: "60" }, "lengthSec"],
    ["childId not a uuid", { ...generic, childId: "nope" }, "childId"],
  ])("400 VALIDATION: %s", async (_label, body, field) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.message).toContain(field);
  });

  it("another user's child → 404, nothing created", async () => {
    const res = await post({ topic: "ducks", mood: "calm", lengthSec: 60, childId: BOBS_CHILD });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(fake.state.songs).toHaveLength(0);
  });

  it("401 without a token", async () => {
    expect((await request(app).post("/api/songs").send(generic)).status).toBe(401);
  });
});

describe("GET /api/songs and /api/songs/:id", () => {
  it("lists the user's songs newest first as SongSummary, with meta.total and ?status filter", async () => {
    seedSong("s-old", { status: "ready" });
    seedSong("s-new", { status: "writing", audio_key: null, image_key: null });
    seedSong("s-bob", { user_id: BOB.id });

    const res = await request(app).get("/api/songs").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 2 });
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual(["s-new", "s-old"]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["childId", "createdAt", "id", "imageUrl", "mood", "status", "title", "topic"]);

    const ready = await request(app).get("/api/songs?status=ready").set(auth());
    expect(ready.body.data.map((s: { id: string }) => s.id)).toEqual(["s-old"]);
    expect((await request(app).get("/api/songs?status=bogus").set(auth())).status).toBe(400);
  });

  it("maps a row to Song: parsed JSON, versioned media URLs, error only when failed", async () => {
    seedSong("s1", { error: "stale error text" });
    const res = await request(app).get("/api/songs/s1").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: "s1", childId: null, topic: "ducks", mood: "playful", ageBand: "3-5", lengthSec: 60, status: "pending_review",
      title: "Duck Song", lyrics: ["quack", "quack"], safety: { pass: true, reasons: [] },
      audioUrl: expect.stringMatching(/^\/api\/media\/s1\/audio\?v=[0-9a-f]{8}$/),
      imageUrl: expect.stringMatching(/^\/api\/media\/s1\/image\?v=[0-9a-f]{8}$/),
      durationMs: 60000, error: null, createdAt: expect.any(String), approvedAt: null, shared: false,
    });
    // No raw S3 key ever leaks.
    expect(JSON.stringify(res.body)).not.toContain("songs/a/");

    seedSong("s2", { status: "failed", error: "The generation service is unavailable right now." });
    const failed = (await request(app).get("/api/songs/s2").set(auth())).body.data;
    expect(failed.error).toBe("The generation service is unavailable right now.");
    expect(failed.audioUrl).toBeNull(); // media is not served for failed songs
  });

  it("a new key gives a new v", async () => {
    seedSong("s1");
    const before = (await request(app).get("/api/songs/s1").set(auth())).body.data.imageUrl;
    fake.state.songs[0]!.image_key = "songs/a/s1/image-2.png";
    const after = (await request(app).get("/api/songs/s1").set(auth())).body.data.imageUrl;
    expect(after).not.toBe(before);
  });

  it("another user's song → 404", async () => {
    seedSong("s1");
    const res = await request(app).get("/api/songs/s1").set(auth(BOB));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ data: null, error: { code: "NOT_FOUND", message: expect.any(String) }, meta: {} });
  });
});

describe("approve / reject / regenerate state rules", () => {
  it("approve: pending_review → ready with approvedAt; again → 409 CONFLICT", async () => {
    seedSong("s1");
    const res = await request(app).post("/api/songs/s1/approve").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "ready", approvedAt: expect.any(String) });
    const again = await request(app).post("/api/songs/s1/approve").set(auth());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
  });

  it.each(["queued", "writing", "mixing", "rejected", "failed", "ready"])("approve / reject from %s → 409", async (status) => {
    seedSong("s1", { status });
    expect((await request(app).post("/api/songs/s1/approve").set(auth())).status).toBe(409);
    expect((await request(app).post("/api/songs/s1/reject").set(auth())).status).toBe(409);
    expect(fake.state.songs[0]?.status).toBe(status);
  });

  it("reject: pending_review → rejected", async () => {
    seedSong("s1");
    const res = await request(app).post("/api/songs/s1/reject").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "rejected", audioUrl: null, imageUrl: null });
  });

  it("approve / reject / regenerate another user's song → 404", async () => {
    seedSong("s1");
    for (const path of ["approve", "reject"]) expect((await request(app).post(`/api/songs/s1/${path}`).set(auth(BOB))).status).toBe(404);
    expect((await request(app).post("/api/songs/s1/regenerate").set(auth(BOB)).send({ part: "image" })).status).toBe(404);
    expect(fake.state.songs[0]?.status).toBe("pending_review");
  });

  it.each([
    ["lyrics", "writing"],
    ["music", "composing"],
    ["image", "illustrating"],
  ])("regenerate %s from ready: song queued, approvedAt cleared, job starts at %s", async (part, step) => {
    seedSong("s1", { status: "ready", approved_at: new Date(), child_id: TODDLER }); // generic + ready = shared → 409
    const res = await request(app).post("/api/songs/s1/regenerate").set(auth()).send({ part });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "queued", approvedAt: null });
    expect(fake.state.jobs).toEqual([expect.objectContaining({ song_id: "s1", step, regen_part: part, done_at: null })]);
  });

  it.each(["queued", "composing", "rejected", "failed"])("regenerate from %s → 409", async (status) => {
    seedSong("s1", { status });
    const res = await request(app).post("/api/songs/s1/regenerate").set(auth()).send({ part: "music" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(fake.state.jobs).toHaveLength(0);
  });

  it("regenerate: bad part → 400", async () => {
    seedSong("s1");
    expect((await request(app).post("/api/songs/s1/regenerate").set(auth()).send({ part: "video" })).status).toBe(400);
  });
});

describe("DELETE /api/songs/:id", () => {
  it("deletes the S3 objects, then the row and its jobs", async () => {
    const row = seedSong("s1");
    fake.state.jobs.push({ id: "j1", song_id: "s1" });
    const res = await request(app).delete("/api/songs/s1").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(storage.module.deleteObjects.mock.calls[0]?.[0].sort()).toEqual([row.audio_key, row.image_key, row.raw_audio_key].sort());
    expect(fake.state.songs).toHaveLength(0);
    expect(fake.state.jobs).toHaveLength(0);
  });

  it("S3 failure → 503 and the DB is unchanged", async () => {
    seedSong("s1");
    storage.module.deleteObjects.mockRejectedValueOnce(new Error("S3 down"));
    const before = structuredClone(fake.state);
    const res = await request(app).delete("/api/songs/s1").set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(fake.state).toEqual(before);
  });

  it("another user's song → 404, nothing deleted", async () => {
    seedSong("s1");
    expect((await request(app).delete("/api/songs/s1").set(auth(BOB))).status).toBe(404);
    expect(storage.module.deleteObjects).not.toHaveBeenCalled();
    expect(fake.state.songs).toHaveLength(1);
  });
});

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

// Fresh users per test: the limiter's memory store lives for the whole file.
let seq = 0;
const newUser = () => {
  const n = String(++seq).padStart(12, "0");
  return { id: `dddddddd-dddd-4ddd-8ddd-${n}`, email: `u${n}@example.test` };
};
type User = ReturnType<typeof newUser>;
const auth = (u: User) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});

const body = { topic: "ducks at the pond", mood: "playful", lengthSec: 60, ageBand: "3-5" };
const create = (u: User) => request(app).post("/api/songs").set(auth(u)).send(body);
const regenerate = (u: User, id: string) => request(app).post(`/api/songs/${id}/regenerate`).set(auth(u)).send({ part: "image" });

/** A song in pending_review so it can be regenerated; regenerate re-queues it, so reset status before each call. */
function seedSong(id: string, u: User) {
  fake.state.songs.push({
    id, user_id: u.id, child_id: null, topic: "ducks", mood: "playful", age_band: "3-5", length_sec: 60, status: "pending_review",
    title: "Duck Song", lyrics: JSON.stringify(["quack"]), music_prompt: "ukulele", image_prompt: "a duck",
    safety_result: JSON.stringify({ pass: true, reasons: [] }), raw_audio_key: `songs/a/${id}/raw-1.mp3`, audio_key: `songs/a/${id}/audio-1.mp3`,
    image_key: `songs/a/${id}/image-1.png`, video_key: null, duration_ms: 60000, error: null, approved_at: null,
    created_at: fake.peekNow(), updated_at: null,
  });
}
function makeRegenerable(id: string) {
  const song = fake.state.songs.find((s) => s.id === id);
  if (song) song.status = "pending_review";
  fake.state.jobs.length = 0;
}

beforeEach(() => {
  fake.reset();
  storage.reset();
});

const expectLimited = (res: request.Response) => {
  expect(res.status).toBe(429);
  expect(res.body).toEqual({ data: null, error: { code: "RATE_LIMITED", message: expect.any(String) }, meta: {} });
};

describe("song generation rate limit (10 per hour per user, shared by create + regenerate)", () => {
  it("the 11th create gets 429 RATE_LIMITED and queues nothing", async () => {
    const u = newUser();
    for (let i = 0; i < 10; i++) expect((await create(u)).status).toBe(201);
    expectLimited(await create(u));
    expect(fake.state.songs).toHaveLength(10);
  });

  it("the 11th regenerate gets 429", async () => {
    const u = newUser();
    seedSong("r1", u);
    for (let i = 0; i < 10; i++) {
      makeRegenerable("r1");
      expect((await regenerate(u, "r1")).status).toBe(200);
    }
    makeRegenerable("r1");
    expectLimited(await regenerate(u, "r1"));
  });

  it("create and regenerate share one budget", async () => {
    const u = newUser();
    seedSong("r2", u);
    for (let i = 0; i < 5; i++) expect((await create(u)).status).toBe(201);
    for (let i = 0; i < 5; i++) {
      makeRegenerable("r2");
      expect((await regenerate(u, "r2")).status).toBe(200);
    }
    expectLimited(await create(u));
    makeRegenerable("r2");
    expectLimited(await regenerate(u, "r2"));
  });

  it("the budget is per user: another user is unaffected", async () => {
    const a = newUser();
    const b = newUser();
    for (let i = 0; i < 10; i++) await create(a);
    expectLimited(await create(a));
    expect((await create(b)).status).toBe(201);
  });

  it("failed requests (validation, 404, 409) do not consume the budget", async () => {
    const u = newUser();
    for (let i = 0; i < 12; i++) expect((await request(app).post("/api/songs").set(auth(u)).send({ ...body, mood: "spooky" })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await regenerate(u, "missing")).status).toBe(404);
    for (let i = 0; i < 10; i++) expect((await create(u)).status).toBe(201);
    expectLimited(await create(u));
  });
});

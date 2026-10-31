// Shared catalog of generic songs: visibility, library_items, media, regenerate/delete rules, admin removal.
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

type U = { id: string; email: string; role: "admin" | "parent" };
const ALICE: U = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test", role: "parent" };
const BOB: U = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test", role: "parent" };
const ADMIN: U = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "admin@example.test", role: "admin" };
const auth = (u: U) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email, role: u.role }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});
const MIA = "c1111111-1111-4111-8111-111111111111"; // Alice's child
const MAX = "c3333333-3333-4333-8333-333333333333"; // Bob's child
const TOPIC = "SECRET-TOPIC grandma's house on Elm Street";
const sid = (n: number) => `5a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = Record<string, unknown>;
/** A song row inserted directly; default = Alice's shared (ready generic) song with media in S3. */
function seedSong(id: string, over: Row = {}): Row {
  const row: Row = {
    id, user_id: ALICE.id, child_id: null, topic: TOPIC, mood: "playful", age_band: "3-5", length_sec: 60, status: "ready",
    title: "Duck Song", lyrics: JSON.stringify(["quack", "quack"]), music_prompt: "ukulele", image_prompt: "a duck",
    safety_result: JSON.stringify({ pass: true, reasons: [] }), raw_audio_key: `songs/x/${id}/raw-1.mp3`, audio_key: `songs/x/${id}/audio-1.mp3`,
    image_key: `songs/x/${id}/image-1.png`, video_key: null, duration_ms: 60000, error: null, approved_at: fake.peekNow(),
    owner_deleted_at: null, catalog_removed_at: null, created_at: fake.peekNow(), updated_at: null, ...over,
  };
  fake.state.songs.push(row);
  for (const k of ["raw_audio_key", "audio_key", "image_key"]) {
    if (typeof row[k] === "string") storage.objects.set(row[k] as string, { body: Buffer.from(`bytes of ${k}`), contentType: k === "image_key" ? "image/png" : "audio/mpeg" });
  }
  fake.advance(1000);
  return row;
}
const libraryItem = (user: U, songId: string) => fake.state.library_items.push({ user_id: user.id, song_id: songId, created_at: new Date() });
const itemsOf = (songId: string) => fake.state.library_items.filter((li) => li.song_id === songId).map((li) => li.user_id).sort();
const row = (id: string) => fake.state.songs.find((s) => s.id === id) as Row;

const catalog = (u: U, q = "") => request(app).get(`/api/catalog${q}`).set(auth(u));
const catalogIds = async (u: U, q = "") => ((await catalog(u, q)).body.data as { id: string }[]).map((s) => s.id);
const libraryIds = async (u: U, q = "") => ((await request(app).get(`/api/library${q}`).set(auth(u))).body.data as { id: string }[]).map((s) => s.id).sort();
const media = (u: U, id: string, kind = "audio") => request(app).get(`/api/media/${id}/${kind}`).set(auth(u));

beforeEach(() => {
  fake.reset();
  storage.reset();
  fake.state.children.push(
    { id: MIA, user_id: ALICE.id, display_name: "Mia", phonetic_name: null, age_band: "3-5", created_at: new Date() },
    { id: MAX, user_id: BOB.id, display_name: "Max", phonetic_name: null, age_band: "3-5", created_at: new Date() },
  );
});

describe("approve shares a generic song", () => {
  it("generic: shared + in the creator's library_items; personalized: neither", async () => {
    seedSong(sid(1), { status: "pending_review", approved_at: null });
    seedSong(sid(2), { status: "pending_review", approved_at: null, child_id: MIA });
    const generic = await request(app).post(`/api/songs/${sid(1)}/approve`).set(auth(ALICE));
    expect(generic.body.data).toMatchObject({ status: "ready", shared: true });
    const personal = await request(app).post(`/api/songs/${sid(2)}/approve`).set(auth(ALICE));
    expect(personal.body.data).toMatchObject({ status: "ready", shared: false });
    expect(fake.state.library_items).toEqual([expect.objectContaining({ user_id: ALICE.id, song_id: sid(1) })]);
    expect(await catalogIds(BOB)).toEqual([sid(1)]);
  });
});

describe("GET /api/catalog", () => {
  it("lists only shared songs; never pending, personalized or removed ones; never topic or creator", async () => {
    seedSong(sid(1)); // shared
    seedSong(sid(2), { status: "pending_review", approved_at: null });
    seedSong(sid(3), { child_id: MIA });
    seedSong(sid(4), { catalog_removed_at: new Date() });
    seedSong(sid(5), { owner_deleted_at: new Date() }); // creator deleted it: still shared
    seedSong(sid(6), { user_id: BOB.id, status: "rejected" });
    seedSong(sid(7), { user_id: BOB.id, mood: "calm" }); // Bob's shared
    libraryItem(BOB, sid(1));

    const res = await catalog(BOB);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, total: 3 });
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([sid(7), sid(5), sid(1)]); // newest approval first
    expect(res.body.data[2]).toEqual({
      id: sid(1), title: "Duck Song", mood: "playful", ageBand: "3-5", lyrics: ["quack", "quack"],
      audioUrl: expect.stringMatching(new RegExp(`^/api/media/${sid(1)}/audio\\?v=[0-9a-f]{8}$`)),
      imageUrl: expect.stringMatching(new RegExp(`^/api/media/${sid(1)}/image\\?v=[0-9a-f]{8}$`)),
      durationMs: 60000, inMyLibrary: true, mine: false,
    });
    const body = JSON.stringify(res.body);
    for (const leak of ["SECRET-TOPIC", "topic", ALICE.id, ALICE.email, "user_id", "songs/x/"]) expect(body).not.toContain(leak);
  });

  it("mine is true for my own songs, false once I deleted them; inMyLibrary per account", async () => {
    seedSong(sid(1));
    seedSong(sid(2), { owner_deleted_at: new Date() });
    libraryItem(ALICE, sid(1));
    const mine = Object.fromEntries((await catalog(ALICE)).body.data.map((s: { id: string; mine: boolean; inMyLibrary: boolean }) => [s.id, [s.mine, s.inMyLibrary]]));
    expect(mine).toEqual({ [sid(1)]: [true, true], [sid(2)]: [false, false] });
  });

  it("filters by mood and ageBand, 24 per page, meta numbers; bad query → 400", async () => {
    for (let n = 1; n <= 30; n++) seedSong(sid(n), { mood: n % 3 === 0 ? "lullaby" : "playful", age_band: n <= 5 ? "1-2" : "3-5" });
    const p1 = await catalog(BOB);
    expect(p1.body.data).toHaveLength(24);
    expect(p1.body.meta).toEqual({ page: 1, total: 30 });
    const p2 = await catalog(BOB, "?page=2");
    expect(p2.body.data).toHaveLength(6);
    expect(p2.body.meta).toEqual({ page: 2, total: 30 });
    expect((await catalog(BOB, "?page=3")).body).toEqual({ data: [], error: null, meta: { page: 3, total: 30 } });

    const lullabies = await catalog(BOB, "?mood=lullaby");
    expect(lullabies.body.meta.total).toBe(10);
    expect(lullabies.body.data.every((s: { mood: string }) => s.mood === "lullaby")).toBe(true);
    expect((await catalog(BOB, "?ageBand=1-2&mood=playful")).body.meta.total).toBe(4); // 1,2,4,5
    expect((await catalog(BOB, "?mood=&ageBand=&page=")).body.meta).toEqual({ page: 1, total: 30 }); // blank = no filter

    for (const q of ["?page=0", "?page=abc", "?mood=spooky", "?ageBand=6-8"]) {
      const res = await catalog(BOB, q);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
    }
    expect((await request(app).get("/api/catalog")).status).toBe(401);
  });
});

describe("POST /api/library/items + DELETE /api/library/items/:songId", () => {
  it("adds a shared song to my player (idempotent) and removes it again (idempotent)", async () => {
    seedSong(sid(1));
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post("/api/library/items").set(auth(BOB)).send({ songId: sid(1) });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: null, error: null, meta: {} });
    }
    expect(itemsOf(sid(1))).toEqual([BOB.id]);
    expect(await libraryIds(BOB)).toEqual([sid(1)]);

    for (let i = 0; i < 2; i++) {
      const res = await request(app).delete(`/api/library/items/${sid(1)}`).set(auth(BOB));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: null, error: null, meta: {} });
    }
    expect(itemsOf(sid(1))).toEqual([]);
    expect(row(sid(1)).status).toBe("ready"); // the song itself is untouched
  });

  it("404 for a song that is not shared (pending, personalized, removed, rejected, unknown); 400 for a bad id", async () => {
    seedSong(sid(1), { status: "pending_review" });
    seedSong(sid(2), { child_id: MIA });
    seedSong(sid(3), { catalog_removed_at: new Date() });
    seedSong(sid(4), { status: "rejected" });
    for (const songId of [sid(1), sid(2), sid(3), sid(4), sid(99)]) {
      const res = await request(app).post("/api/library/items").set(auth(BOB)).send({ songId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect((await request(app).post("/api/library/items").set(auth(BOB)).send({ songId: "nope" })).status).toBe(400);
    expect(fake.state.library_items).toHaveLength(0);
  });

  it("the creator can take their own shared song out of their player; it stays shared", async () => {
    seedSong(sid(1));
    libraryItem(ALICE, sid(1));
    libraryItem(BOB, sid(1));
    expect((await request(app).delete(`/api/library/items/${sid(1)}`).set(auth(ALICE))).status).toBe(200);
    expect(itemsOf(sid(1))).toEqual([BOB.id]);
    expect(await libraryIds(ALICE)).toEqual([]);
    expect(await catalogIds(BOB)).toEqual([sid(1)]);
    expect((await request(app).get(`/api/songs/${sid(1)}`).set(auth(ALICE))).body.data.shared).toBe(true);
  });
});

describe("media across accounts", () => {
  it("any signed-in user may stream a shared song; never a personalized or unshared one of another account", async () => {
    seedSong(sid(1)); // shared
    seedSong(sid(2), { child_id: MIA }); // Alice's personalized, ready
    seedSong(sid(3), { status: "pending_review", approved_at: null }); // Alice's generic, not yet approved
    seedSong(sid(4), { catalog_removed_at: new Date() }); // removed by the admin: private again

    const shared = await media(BOB, sid(1)).buffer(true);
    expect(shared.status).toBe(200);
    expect(storage.module.getObjectStream).toHaveBeenLastCalledWith(row(sid(1)).audio_key, undefined); // normalized, never raw
    expect((await media(BOB, sid(1), "image")).status).toBe(200);
    for (const id of [sid(2), sid(3), sid(4)]) {
      expect((await media(BOB, id)).status).toBe(404);
      expect((await media(ALICE, id)).status).toBe(200); // the owner still can
    }

    // Shared only while shared: after the admin removes it, Bob loses access.
    expect((await request(app).delete(`/api/catalog/${sid(1)}`).set(auth(ADMIN))).status).toBe(200);
    expect((await media(BOB, sid(1))).status).toBe(404);
    expect((await media(ALICE, sid(1))).status).toBe(200);
  });
});

describe("regenerate + creator delete on shared songs", () => {
  it("regenerate a shared song → 409 CONFLICT; pending generic and admin-removed songs regenerate as before", async () => {
    seedSong(sid(1));
    const res = await request(app).post(`/api/songs/${sid(1)}/regenerate`).set(auth(ALICE)).send({ part: "image" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ data: null, error: { code: "CONFLICT", message: "Shared songs can't be changed — make a new song" }, meta: {} });
    expect(fake.state.jobs).toHaveLength(0);

    seedSong(sid(2), { status: "pending_review", approved_at: null });
    seedSong(sid(3), { catalog_removed_at: new Date() });
    for (const id of [sid(2), sid(3)]) {
      const ok = await request(app).post(`/api/songs/${id}/regenerate`).set(auth(ALICE)).send({ part: "music" });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ status: "queued", shared: false });
    }
    expect(fake.state.jobs).toHaveLength(2);
  });

  it("creator deletes a shared song → soft delete: gone for the creator, kept for others, files kept", async () => {
    seedSong(sid(1));
    libraryItem(ALICE, sid(1));
    libraryItem(BOB, sid(1));

    const res = await request(app).delete(`/api/songs/${sid(1)}`).set(auth(ALICE));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(row(sid(1)).owner_deleted_at).toBeInstanceOf(Date);
    expect(storage.module.deleteObjects).not.toHaveBeenCalled();
    expect(itemsOf(sid(1))).toEqual([BOB.id]);

    // Hidden from the creator everywhere.
    expect((await request(app).get(`/api/songs/${sid(1)}`).set(auth(ALICE))).status).toBe(404);
    expect((await request(app).get("/api/songs").set(auth(ALICE))).body.data).toEqual([]);
    expect((await request(app).get("/api/songs?status=ready").set(auth(ALICE))).body.data).toEqual([]);
    expect((await request(app).delete(`/api/songs/${sid(1)}`).set(auth(ALICE))).status).toBe(404);
    expect((await request(app).post(`/api/songs/${sid(1)}/regenerate`).set(auth(ALICE)).send({ part: "image" })).status).toBe(404);
    expect(await libraryIds(ALICE)).toEqual([]);

    // Still shared for everyone else.
    expect(await libraryIds(BOB)).toEqual([sid(1)]);
    expect(await catalogIds(BOB)).toEqual([sid(1)]);
    expect((await media(BOB, sid(1))).status).toBe(200);
  });

  it("deleting a non-shared song is still a hard delete (row, jobs, library_items, S3)", async () => {
    const r = seedSong(sid(1), { catalog_removed_at: new Date() });
    libraryItem(ALICE, sid(1));
    expect((await request(app).delete(`/api/songs/${sid(1)}`).set(auth(ALICE))).status).toBe(200);
    expect(fake.state.songs).toHaveLength(0);
    expect(fake.state.library_items).toHaveLength(0);
    expect(storage.module.deleteObjects.mock.calls[0]?.[0].sort()).toEqual([r.audio_key, r.image_key, r.raw_audio_key].sort());
  });
});

describe("DELETE /api/catalog/:songId (admin)", () => {
  it("creator has not deleted it → removed for everyone, kept privately by the creator", async () => {
    seedSong(sid(1));
    libraryItem(BOB, sid(1));
    libraryItem(ADMIN, sid(1));

    const res = await request(app).delete(`/api/catalog/${sid(1)}`).set(auth(ADMIN));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(row(sid(1)).catalog_removed_at).toBeInstanceOf(Date);
    expect(itemsOf(sid(1))).toEqual([ALICE.id]); // others' rows gone; the creator's re-inserted
    expect(storage.module.deleteObjects).not.toHaveBeenCalled();

    expect(await catalogIds(BOB)).toEqual([]);
    expect(await libraryIds(BOB)).toEqual([]);
    expect(await libraryIds(ALICE)).toEqual([sid(1)]);
    expect((await request(app).get(`/api/songs/${sid(1)}`).set(auth(ALICE))).body.data).toMatchObject({ status: "ready", shared: false });
    expect((await request(app).post("/api/library/items").set(auth(BOB)).send({ songId: sid(1) })).status).toBe(404);

    // Already removed → 404; so is a personalized or unknown song.
    seedSong(sid(2), { child_id: MIA });
    for (const id of [sid(1), sid(2), sid(99)]) expect((await request(app).delete(`/api/catalog/${id}`).set(auth(ADMIN))).status).toBe(404);
  });

  it("creator already deleted it → hard delete of the row, its library_items and its S3 objects", async () => {
    const r = seedSong(sid(1), { owner_deleted_at: new Date() });
    libraryItem(BOB, sid(1));
    fake.state.jobs.push({ id: "j1", song_id: sid(1) });

    expect((await request(app).delete(`/api/catalog/${sid(1)}`).set(auth(ADMIN))).status).toBe(200);
    expect(fake.state.songs).toHaveLength(0);
    expect(fake.state.library_items).toHaveLength(0);
    expect(fake.state.jobs).toHaveLength(0);
    expect(storage.module.deleteObjects.mock.calls[0]?.[0].sort()).toEqual([r.audio_key, r.image_key, r.raw_audio_key].sort());
    expect(storage.objects.size).toBe(0);
  });

  it("hard delete: S3 failure → 503 and the DB is unchanged", async () => {
    seedSong(sid(1), { owner_deleted_at: new Date() });
    libraryItem(BOB, sid(1));
    storage.module.deleteObjects.mockRejectedValueOnce(new Error("S3 down"));
    const before = structuredClone(fake.state);
    const res = await request(app).delete(`/api/catalog/${sid(1)}`).set(auth(ADMIN));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(fake.state).toEqual(before);
  });
});

describe("GET /api/library composition across two accounts", () => {
  it("my child's ready songs + my library_items songs still shared (or my own kept privately); never another account's personalized song", async () => {
    seedSong(sid(1), { child_id: MIA }); // Alice → Mia, ready
    seedSong(sid(2), { child_id: MIA, status: "pending_review" }); // not ready
    seedSong(sid(3)); // Alice's shared
    seedSong(sid(4), { catalog_removed_at: new Date() }); // Alice's, removed by admin, kept privately
    seedSong(sid(5), { user_id: BOB.id }); // Bob's shared, added by Alice
    seedSong(sid(6), { user_id: BOB.id }); // Bob's shared, not added by Alice
    seedSong(sid(7), { user_id: BOB.id, child_id: MAX }); // Bob → Max
    seedSong(sid(8), { user_id: BOB.id, catalog_removed_at: new Date() }); // Bob's, removed: no longer shared
    seedSong(sid(9)); // Alice's shared, but she removed it from her player
    for (const id of [sid(3), sid(4), sid(5), sid(8)]) libraryItem(ALICE, id);
    for (const id of [sid(3), sid(6), sid(8)]) libraryItem(BOB, id);
    // Stale/corrupt rows pointing at personalized songs never surface.
    libraryItem(ALICE, sid(7));
    libraryItem(BOB, sid(1));

    expect(await libraryIds(ALICE)).toEqual([sid(3), sid(4), sid(5)].sort());
    expect(await libraryIds(ALICE, `?childId=${MIA}`)).toEqual([sid(1), sid(3), sid(4), sid(5)].sort());
    expect(await libraryIds(BOB)).toEqual([sid(3), sid(6), sid(8)].sort());
    expect(await libraryIds(BOB, `?childId=${MAX}`)).toEqual([sid(3), sid(6), sid(7), sid(8)].sort());
    expect((await request(app).get(`/api/library?childId=${MIA}`).set(auth(BOB))).status).toBe(404);
  });
});

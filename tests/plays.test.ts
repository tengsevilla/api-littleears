// Play tracking (POST /api/plays) + admin stats (GET /api/admin/stats).
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

type U = { id: string; email: string; role: "admin" | "parent" };
const ALICE: U = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test", role: "parent" };
const BOB: U = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test", role: "parent" };
const ADMIN: U = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "admin@example.test", role: "admin" };
const auth = (u: U) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email, role: u.role }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});
const MIA = "c1111111-1111-4111-8111-111111111111"; // Alice's child
const sid = (n: number) => `5a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = Record<string, unknown>;
/** Default: Alice's shared (ready generic) song. */
function seedSong(id: string, over: Row = {}): Row {
  const row: Row = {
    id, user_id: ALICE.id, child_id: null, topic: "ducks", mood: "playful", age_band: "3-5", length_sec: 60, status: "ready",
    title: "Duck Song", lyrics: JSON.stringify(["quack"]), music_prompt: "ukulele", image_prompt: "a duck",
    safety_result: JSON.stringify({ pass: true, reasons: [] }), raw_audio_key: `songs/x/${id}/raw-1.mp3`, audio_key: `songs/x/${id}/audio-1.mp3`,
    image_key: `songs/x/${id}/image-1.png`, video_key: null, duration_ms: 60000, error: null, approved_at: new Date(),
    owner_deleted_at: null, catalog_removed_at: null, created_at: new Date(), updated_at: null, ...over,
  };
  fake.state.songs.push(row);
  return row;
}
const NOW = new Date("2026-06-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;
const seedPlay = (u: U, item: { song_id?: string; sound_slug?: string }, played_at: Date) =>
  fake.state.play_events.push({ id: fake.state.play_events.length + 1, user_id: u.id, song_id: item.song_id ?? null, sound_slug: item.sound_slug ?? null, played_at, created_at: played_at });

const play = (u: U, body: unknown) => request(app).post("/api/plays").set(auth(u)).send(body as object);
const stats = (u: U, q = "") => request(app).get(`/api/admin/stats${q}`).set(auth(u));
const plays = () => fake.state.play_events;

beforeEach(() => {
  fake.reset();
  storage.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.state.users.push(
    { id: ALICE.id, email: ALICE.email, role: "parent" },
    { id: BOB.id, email: BOB.email, role: "parent" },
    { id: ADMIN.id, email: ADMIN.email, role: "admin" },
  );
  fake.state.children.push({ id: MIA, user_id: ALICE.id, display_name: "Mia", phonetic_name: null, age_band: "3-5", created_at: new Date() });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/plays — validation", () => {
  it.each([
    ["empty body", {}],
    ["both songId and soundSlug", { songId: sid(1), soundSlug: "rain" }],
    ["bad songId", { songId: "nope" }],
    ["bad soundSlug", { soundSlug: "Rain Drops!" }],
    ["too long soundSlug", { soundSlug: "a".repeat(41) }],
    ["bad playedAt", { soundSlug: "rain", playedAt: "yesterday" }],
  ])("%s → 400 VALIDATION", async (_name, body) => {
    const res = await play(ALICE, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ data: null, error: { code: "VALIDATION", message: expect.any(String) }, meta: {} });
    expect(plays()).toHaveLength(0);
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).post("/api/plays").send({ soundSlug: "rain" })).status).toBe(401);
  });

  it("playedAt: at most 7 days old and not in the future", async () => {
    expect((await play(ALICE, { soundSlug: "rain", playedAt: ago(7 * DAY + 1000).toISOString() })).status).toBe(400);
    expect((await play(ALICE, { soundSlug: "rain", playedAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() })).status).toBe(400);
    const ok = await play(ALICE, { soundSlug: "rain", playedAt: ago(6 * DAY).toISOString() });
    expect(ok.status).toBe(200);
    expect(plays()).toEqual([expect.objectContaining({ user_id: ALICE.id, sound_slug: "rain", song_id: null, played_at: ago(6 * DAY) })]);
  });
});

describe("POST /api/plays — what counts", () => {
  it("own ready song is counted, stored without child or device info", async () => {
    seedSong(sid(1), { child_id: MIA });
    const res = await play(ALICE, { songId: sid(1), extra: "dropped" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(plays()).toEqual([{ id: 1, user_id: ALICE.id, song_id: sid(1), sound_slug: null, played_at: NOW, created_at: expect.any(Date) }]);
  });

  it("a shared song from another account is counted", async () => {
    seedSong(sid(1));
    expect((await play(BOB, { songId: sid(1) })).status).toBe(200);
    expect(plays()).toEqual([expect.objectContaining({ user_id: BOB.id, song_id: sid(1) })]);
  });

  it("another account's personalized song → 404", async () => {
    seedSong(sid(1), { child_id: MIA });
    const res = await play(BOB, { songId: sid(1) });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(plays()).toHaveLength(0);
  });

  it("a pending_review song (studio preview) → 404, also for its owner; unknown song → 404", async () => {
    seedSong(sid(1), { status: "pending_review", approved_at: null });
    expect((await play(ALICE, { songId: sid(1) })).status).toBe(404);
    expect((await play(ALICE, { songId: sid(9) })).status).toBe(404);
    expect(plays()).toHaveLength(0);
  });

  it("a sound slug is counted", async () => {
    expect((await play(BOB, { soundSlug: "ocean-waves" })).status).toBe(200);
    expect(plays()).toEqual([expect.objectContaining({ user_id: BOB.id, song_id: null, sound_slug: "ocean-waves" })]);
  });

  it("dedupe: same user + item within 30 s is ignored (still 200); counted after 30 s", async () => {
    seedSong(sid(1));
    expect((await play(ALICE, { songId: sid(1) })).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 29_000));
    expect((await play(ALICE, { songId: sid(1) })).status).toBe(200);
    expect(plays()).toHaveLength(1);
    // another user / another item is not deduped
    await play(BOB, { songId: sid(1) });
    await play(ALICE, { soundSlug: "rain" });
    expect(plays()).toHaveLength(3);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await play(ALICE, { songId: sid(1) });
    expect(plays().filter((p) => p.user_id === ALICE.id && p.song_id === sid(1))).toHaveLength(2);
  });

  it("dedupe also applies to an offline play queued just before an existing one", async () => {
    await play(ALICE, { soundSlug: "rain" });
    await play(ALICE, { soundSlug: "rain", playedAt: ago(20_000).toISOString() });
    expect(plays()).toHaveLength(1);
    await play(ALICE, { soundSlug: "rain", playedAt: ago(40_000).toISOString() });
    expect(plays()).toHaveLength(2);
  });

  it("deleting a song removes its plays", async () => {
    seedSong(sid(1), { child_id: MIA });
    await play(ALICE, { songId: sid(1) });
    await play(ALICE, { soundSlug: "rain" });
    expect((await request(app).delete(`/api/songs/${sid(1)}`).set(auth(ALICE))).status).toBe(200);
    expect(plays()).toEqual([expect.objectContaining({ sound_slug: "rain" })]);
  });
});

describe("POST /api/plays — rate limit", () => {
  it("301st play in an hour → 429 RATE_LIMITED", async () => {
    const u: U = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", email: "e@example.test", role: "parent" };
    for (let i = 0; i < 300; i++) {
      expect((await play(u, { soundSlug: `s-${i}` })).status).toBe(200);
    }
    const res = await play(u, { soundSlug: "one-more" });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ data: null, error: { code: "RATE_LIMITED", message: expect.any(String) }, meta: {} });
  }, 120_000); // 301 requests: slow when the whole suite runs in parallel
});

describe("GET /api/admin/stats", () => {
  it("403 FORBIDDEN for a parent; 400 for a bad range", async () => {
    const res = await stats(ALICE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect((await stats(ADMIN, "?range=1y")).status).toBe(400);
  });

  it("totals, top songs, top sounds (default range 30d)", async () => {
    seedSong(sid(1), { title: "Duck Song" }); // Alice, shared
    seedSong(sid(2), { title: "Bee Song", user_id: BOB.id }); // Bob, shared
    seedSong(sid(3), { title: "Admin Lullaby", user_id: ADMIN.id, status: "pending_review", child_id: "c9" }); // admin's own
    seedSong(sid(4), { title: "Old", owner_deleted_at: new Date(), created_at: ago(2 * DAY) }); // shared, creator-deleted
    seedSong(sid(5), { title: "Ancient", created_at: ago(60 * DAY) });
    fake.state.library_items.push({ user_id: ALICE.id, song_id: sid(1) }, { user_id: BOB.id, song_id: sid(1) });
    seedPlay(ALICE, { song_id: sid(1) }, ago(DAY));
    seedPlay(BOB, { song_id: sid(1) }, ago(2 * DAY));
    seedPlay(BOB, { song_id: sid(1) }, ago(3 * DAY));
    seedPlay(BOB, { song_id: sid(2) }, ago(DAY));
    seedPlay(ADMIN, { song_id: sid(3) }, ago(DAY));
    seedPlay(ALICE, { sound_slug: "rain" }, ago(DAY));
    seedPlay(BOB, { sound_slug: "rain" }, ago(DAY));
    seedPlay(BOB, { sound_slug: "ocean" }, ago(DAY));
    seedPlay(BOB, { sound_slug: "ocean" }, ago(40 * DAY)); // outside 30d

    const res = await stats(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.meta).toEqual({});
    const d = res.body.data;
    expect(d.totals).toEqual({ plays: 8, songPlays: 5, soundPlays: 3, activeFamilies: 3, families: 3, songsCreated: 3, sharedSongs: 4 });
    expect(d.topSongs).toEqual([
      { id: sid(1), title: "Duck Song", imageUrl: expect.stringMatching(new RegExp(`^/api/media/${sid(1)}/image\\?v=[0-9a-f]{8}$`)), plays: 3, families: 2, libraryAdds: 2, mine: false },
      { id: sid(3), title: "Admin Lullaby", imageUrl: expect.stringContaining(`/api/media/${sid(3)}/image?v=`), plays: 1, families: 1, libraryAdds: 0, mine: true },
      { id: sid(2), title: "Bee Song", imageUrl: expect.any(String), plays: 1, families: 1, libraryAdds: 0, mine: false },
    ]);
    expect(d.topSounds).toEqual([
      { slug: "rain", plays: 2, families: 2 },
      { slug: "ocean", plays: 1, families: 1 },
    ]);
    expect(d.personalizedPlays).toBe(0);
  });

  it("daily is zero-filled by UTC date and the range filters plays", async () => {
    seedPlay(ALICE, { sound_slug: "rain" }, new Date("2026-06-15T00:30:00Z")); // today
    seedPlay(ALICE, { sound_slug: "rain" }, new Date("2026-06-13T23:59:00Z"));
    seedPlay(BOB, { sound_slug: "rain" }, new Date("2026-06-09T00:00:00Z")); // first day of 7d
    seedPlay(BOB, { sound_slug: "rain" }, new Date("2026-06-08T23:59:59Z")); // just outside 7d
    seedPlay(BOB, { sound_slug: "rain" }, new Date("2026-04-01T10:00:00Z")); // outside 30d, inside 90d

    const week = (await stats(ADMIN, "?range=7d")).body.data;
    expect(week.daily).toEqual([
      { date: "2026-06-09", songPlays: 0, soundPlays: 1 },
      { date: "2026-06-10", songPlays: 0, soundPlays: 0 },
      { date: "2026-06-11", songPlays: 0, soundPlays: 0 },
      { date: "2026-06-12", songPlays: 0, soundPlays: 0 },
      { date: "2026-06-13", songPlays: 0, soundPlays: 1 },
      { date: "2026-06-14", songPlays: 0, soundPlays: 0 },
      { date: "2026-06-15", songPlays: 0, soundPlays: 1 },
    ]);
    expect(week.totals).toMatchObject({ plays: 3, activeFamilies: 2 });

    const month = (await stats(ADMIN, "?range=30d")).body.data;
    expect(month.daily).toHaveLength(30);
    expect(month.daily[0].date).toBe("2026-05-17");
    expect(month.totals.plays).toBe(4);

    expect((await stats(ADMIN, "?range=90d")).body.data.totals.plays).toBe(5);

    const all = (await stats(ADMIN, "?range=all")).body.data;
    expect(all.totals.plays).toBe(5);
    expect(all.daily[0]).toEqual({ date: "2026-04-01", songPlays: 0, soundPlays: 1 });
    expect(all.daily.at(-1).date).toBe("2026-06-15");
    expect(all.daily).toHaveLength(76);
  });

  it("range=all with no plays → empty daily, zero totals", async () => {
    const d = (await stats(ADMIN, "?range=all")).body.data;
    expect(d.daily).toEqual([]);
    expect(d.totals).toMatchObject({ plays: 0, songPlays: 0, soundPlays: 0, activeFamilies: 0 });
    expect(d.topSongs).toEqual([]);
    expect(d.topSounds).toEqual([]);
  });

  it("privacy: another family's personalized song never appears in topSongs; it only adds to personalizedPlays", async () => {
    seedSong(sid(1), { child_id: MIA, title: "Mia's Bedtime Song" }); // Alice's personalized
    seedSong(sid(2), { title: "Removed Generic", catalog_removed_at: new Date() }); // Alice's, no longer shared
    seedSong(sid(3), { title: "Shared One" });
    seedPlay(ALICE, { song_id: sid(1) }, ago(DAY));
    seedPlay(ALICE, { song_id: sid(1) }, ago(2 * DAY));
    seedPlay(ALICE, { song_id: sid(2) }, ago(DAY));
    seedPlay(BOB, { song_id: sid(3) }, ago(DAY));

    const res = await stats(ADMIN);
    const d = res.body.data;
    expect(d.topSongs.map((s: { id: string }) => s.id)).toEqual([sid(3)]);
    expect(d.personalizedPlays).toBe(2);
    expect(d.totals.songPlays).toBe(4);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("Mia");
    expect(text).not.toContain(sid(1));
    expect(text).not.toContain("Removed Generic");
  });
});

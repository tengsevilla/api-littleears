import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const deleteObjects = vi.fn<(keys: string[]) => Promise<void>>();
vi.mock("../src/lib/storage.js", () => ({ deleteObjects }));

const { default: app } = await import("../src/app.js");

const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const auth = (u = ALICE) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});

const MIA = "c1111111-1111-4111-8111-111111111111";
const LEO = "c2222222-2222-4222-8222-222222222222";

function song(id: string, childId: string | null, keys: Partial<Record<"raw_audio_key" | "audio_key" | "image_key" | "video_key", string>> = {}) {
  return { id, user_id: ALICE.id, child_id: childId, raw_audio_key: null, audio_key: null, image_key: null, video_key: null, ...keys };
}

beforeEach(() => {
  fake.reset();
  deleteObjects.mockReset();
  deleteObjects.mockResolvedValue(undefined);
  fake.state.children.push(
    { id: MIA, user_id: ALICE.id, display_name: "Mia", phonetic_name: null, age_band: "3-5", created_at: new Date() },
    { id: LEO, user_id: ALICE.id, display_name: "Leo", phonetic_name: null, age_band: "1-2", created_at: new Date() },
  );
  fake.state.songs.push(
    song("s1", MIA, { raw_audio_key: "raw/s1.mp3", audio_key: "audio/s1.mp3", image_key: "img/s1.png" }),
    song("s2", MIA, { image_key: "img/s2.png" }), // partially generated: nulls are skipped
    song("s3", MIA), // nothing generated yet: no S3 objects
    song("s4", LEO, { audio_key: "audio/s4.mp3" }),
    song("s5", null, { audio_key: "audio/s5.mp3" }), // generic song
  );
  fake.state.jobs.push({ id: "j1", song_id: "s1" }, { id: "j4", song_id: "s4" });
});

describe("DELETE /api/children/:id cascade (R4)", () => {
  it("deletes the child's songs, their S3 objects and jobs, and leaves other songs alone", async () => {
    const res = await request(app).delete(`/api/children/${MIA}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(deleteObjects).toHaveBeenCalledTimes(1);
    expect(deleteObjects.mock.calls[0]?.[0].sort()).toEqual(["audio/s1.mp3", "img/s1.png", "img/s2.png", "raw/s1.mp3"]);
    expect(fake.state.children.map((c) => c.id)).toEqual([LEO]);
    expect(fake.state.songs.map((s) => s.id)).toEqual(["s4", "s5"]);
    expect(fake.state.jobs.map((j) => j.id)).toEqual(["j4"]);
  });

  it("does not call S3 when the child has no media", async () => {
    fake.state.songs = fake.state.songs.filter((s) => s.child_id !== LEO);
    const res = await request(app).delete(`/api/children/${LEO}`).set(auth());
    expect(res.status).toBe(200);
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(fake.state.children.map((c) => c.id)).toEqual([MIA]);
  });

  it("fails with 503 and leaves the DB unchanged when S3 deletion fails", async () => {
    deleteObjects.mockRejectedValue(new Error("S3 down"));
    const before = structuredClone(fake.state);

    const res = await request(app).delete(`/api/children/${MIA}`).set(auth());

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ data: null, error: { code: "SERVICE_UNAVAILABLE", message: expect.any(String) }, meta: {} });
    expect(fake.state).toEqual(before);
  });

  it("returns 404 for another user's child without touching S3 or the DB", async () => {
    const before = structuredClone(fake.state);
    const res = await request(app).delete(`/api/children/${MIA}`).set(auth(BOB));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(fake.state).toEqual(before);
  });
});

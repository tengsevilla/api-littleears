import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const AUDIO = Buffer.from("fake-mp3-bytes");
const speak = vi.fn<(input: { text: string }) => Promise<Buffer>>();
vi.mock("../src/providers/index.js", () => ({ getProviders: () => ({ tts: { speak } }) }));

const { default: app } = await import("../src/app.js");
const { ProviderError } = await import("../src/providers/errors.js");

const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const CAROL = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", email: "carol@example.test" };
const auth = (u = ALICE) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});

const MIA = "c1111111-1111-4111-8111-111111111111";
const ZOE = "c2222222-2222-4222-8222-222222222222";
const preview = (id: string, u = ALICE) => request(app).post(`/api/children/${id}/name-preview`).set(auth(u));

beforeEach(() => {
  fake.reset();
  speak.mockReset();
  speak.mockResolvedValue(AUDIO);
  fake.state.children.push(
    { id: MIA, user_id: ALICE.id, display_name: "Mia", phonetic_name: null, age_band: "3-5", created_at: new Date() },
    { id: ZOE, user_id: ALICE.id, display_name: "Zoë", phonetic_name: "ZOH-ee", age_band: "1-2", created_at: new Date() },
  );
});

describe("POST /api/children/:id/name-preview", () => {
  it("requires a JWT", async () => {
    const res = await request(app).post(`/api/children/${MIA}/name-preview`);
    expect(res.status).toBe(401);
    expect(speak).not.toHaveBeenCalled();
  });

  it("speaks displayName when there is no phoneticName and returns a data URL", async () => {
    const res = await preview(MIA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { audioUrl: `data:audio/mpeg;base64,${AUDIO.toString("base64")}` }, error: null, meta: {} });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(speak).toHaveBeenCalledWith({ text: "Mia" });
  });

  it("speaks phoneticName when set (R2)", async () => {
    await preview(ZOE);
    expect(speak).toHaveBeenCalledWith({ text: "ZOH-ee" });
  });

  it("returns 404 for another user's child and never calls TTS", async () => {
    const res = await preview(MIA, BOB);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(speak).not.toHaveBeenCalled();
  });

  it("surfaces provider errors with their internal code", async () => {
    speak.mockRejectedValue(new ProviderError("elevenlabs", "PROVIDER_QUOTA", false));
    const res = await preview(MIA);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ data: null, error: { code: "PROVIDER_QUOTA", message: expect.any(String) }, meta: {} });
  });

  it("rate-limits to 20 previews per 15 minutes per user", async () => {
    fake.state.children.push({ id: "c3", user_id: CAROL.id, display_name: "Ana", phonetic_name: null, age_band: "3-5", created_at: new Date() });
    for (let i = 0; i < 20; i++) expect((await preview("c3", CAROL)).status).toBe(200);
    const res = await preview("c3", CAROL);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});

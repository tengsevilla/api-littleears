// Own file so the register limiter starts empty (each test file gets fresh modules).
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const { default: app } = await import("../src/app.js");

describe("register rate limiting (like login)", () => {
  it("returns 429 RATE_LIMITED after 10 failed registrations", async () => {
    const attempt = () => request(app).post("/api/auth/register").send({ token: "guessed-token", password: "a long enough pw" });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(404);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ data: null, error: { code: "RATE_LIMITED", message: expect.any(String) }, meta: {} });
  }, 60_000); // each attempt runs a real cost-12 bcrypt hash
});

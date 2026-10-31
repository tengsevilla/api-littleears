import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const { default: app } = await import("../src/app.js");

describe("auth rate limiting", () => {
  it("returns 429 RATE_LIMITED after 10 failed logins", async () => {
    const attempt = () =>
      request(app).post("/api/auth/login").send({ email: "nobody@example.test", password: "wrong-password" });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ data: null, error: { code: "RATE_LIMITED", message: expect.any(String) }, meta: {} });
  }, 30_000); // each failed attempt runs a real cost-12 bcrypt compare
});

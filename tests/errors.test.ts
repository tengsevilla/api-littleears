import { describe, it, expect, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/db.js", () => ({ db: { query: vi.fn() } }));

const { default: app } = await import("../src/app.js");

describe("error shape", () => {
  it("returns 404 with { data, error: { code, message }, meta }", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      data: null,
      error: { code: "NOT_FOUND", message: expect.any(String) },
      meta: {},
    });
  });

  it("returns 400 BAD_REQUEST on malformed JSON", async () => {
    const res = await request(app)
      .post("/api/health")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      data: null,
      error: { code: "BAD_REQUEST", message: "Malformed JSON body" },
      meta: {},
    });
  });
});

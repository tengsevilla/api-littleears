import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/lib/db.js", () => ({ db: { query } }));

const { default: app } = await import("../src/app.js");

describe("GET /api/health", () => {
  beforeEach(() => query.mockReset());

  it("returns ok when the DB responds", async () => {
    query.mockResolvedValueOnce([[{ 1: 1 }], []]);
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "ok", db: "ok" }, error: null, meta: {} });
  });

  it("returns 503 with the error shape when the DB is down", async () => {
    query.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      data: null,
      error: { code: "SERVICE_UNAVAILABLE", message: "Database unreachable" },
      meta: {},
    });
  });

  it("allows only the configured CORS origin with credentials", async () => {
    query.mockResolvedValueOnce([[{ 1: 1 }], []]);
    const res = await request(app).get("/api/health").set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

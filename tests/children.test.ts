import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const { default: app } = await import("../src/app.js");

const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const tokenFor = (u: { id: string; email: string }) =>
  jwt.sign({ email: u.email }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 });
const auth = (u = ALICE) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const createChild = (body: object, u = ALICE) => request(app).post("/api/children").set(auth(u)).send(body);

beforeEach(() => fake.reset());

describe("children auth", () => {
  it.each([
    ["get", "/api/children"],
    ["post", "/api/children"],
    ["patch", "/api/children/x"],
    ["delete", "/api/children/x"],
  ] as const)("%s %s requires a JWT", async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ data: null, error: { code: "UNAUTHORIZED", message: expect.any(String) }, meta: {} });
  });
});

describe("POST /api/children", () => {
  it("creates a child and returns the Child shape", async () => {
    const res = await createChild({ displayName: "  Mia  ", ageBand: "3-5" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: { id: expect.stringMatching(UUID), displayName: "Mia", phoneticName: null, ageBand: "3-5", createdAt: expect.stringMatching(ISO) },
      error: null,
      meta: {},
    });
    expect(fake.state.children[0]?.user_id).toBe(ALICE.id);
  });

  it("accepts Unicode letters, spaces, hyphens and a phonetic name", async () => {
    const res = await createChild({ displayName: "Zoë Anne-Marie", phoneticName: "ZOH-ee", ageBand: "1-2" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ displayName: "Zoë Anne-Marie", phoneticName: "ZOH-ee", ageBand: "1-2" });
    expect((await createChild({ displayName: "Søren", ageBand: "1-2" })).status).toBe(201);
    expect((await createChild({ displayName: "Ayşe", ageBand: "1-2" })).status).toBe(201);
  });

  it.each([
    [{ ageBand: "3-5" }, "displayName"],
    [{ displayName: "", ageBand: "3-5" }, "displayName"],
    [{ displayName: "   ", ageBand: "3-5" }, "displayName"],
    [{ displayName: "A".repeat(41), ageBand: "3-5" }, "displayName"],
    [{ displayName: "Mia2", ageBand: "3-5" }, "displayName"],
    [{ displayName: "O'Brien", ageBand: "3-5" }, "displayName"],
    [{ displayName: "Mia", ageBand: "6-8" }, "ageBand"],
    [{ displayName: "Mia" }, "ageBand"],
    [{ displayName: "Mia", ageBand: "3-5", phoneticName: "" }, "phoneticName"],
    [{ displayName: "Mia", ageBand: "3-5", phoneticName: "x".repeat(81) }, "phoneticName"],
  ])("rejects %j with 400 VALIDATION naming %s", async (body, field) => {
    const res = await createChild(body);
    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.message).toContain(field);
    expect(fake.state.children).toHaveLength(0);
  });
});

describe("GET /api/children", () => {
  it("lists only the caller's children, oldest first", async () => {
    await createChild({ displayName: "Mia", ageBand: "3-5" });
    await createChild({ displayName: "Leo", ageBand: "1-2" });
    await createChild({ displayName: "Bobs Kid", ageBand: "1-2" }, BOB);

    const res = await request(app).get("/api/children").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { displayName: string }) => c.displayName)).toEqual(["Mia", "Leo"]);
    expect(res.body.meta).toEqual({ total: 2 });
    expect(res.body.error).toBeNull();
  });
});

describe("PATCH /api/children/:id", () => {
  it("updates provided fields and can clear phoneticName", async () => {
    const id = (await createChild({ displayName: "Mia", phoneticName: "MEE-ah", ageBand: "1-2" })).body.data.id;
    const res = await request(app).patch(`/api/children/${id}`).set(auth()).send({ ageBand: "3-5", phoneticName: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id, displayName: "Mia", phoneticName: null, ageBand: "3-5", createdAt: expect.stringMatching(ISO) },
      error: null,
      meta: {},
    });
  });

  it("rejects an empty or invalid patch with 400 VALIDATION", async () => {
    const id = (await createChild({ displayName: "Mia", ageBand: "1-2" })).body.data.id;
    for (const body of [{}, { displayName: "M1a" }, { ageBand: "9-9" }]) {
      const res = await request(app).patch(`/api/children/${id}`).set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
    }
  });

  it("returns 404 for another user's child and leaves it unchanged", async () => {
    const id = (await createChild({ displayName: "Mia", ageBand: "1-2" })).body.data.id;
    const res = await request(app).patch(`/api/children/${id}`).set(auth(BOB)).send({ displayName: "Hacked" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ data: null, error: { code: "NOT_FOUND", message: "Child not found" }, meta: {} });
    expect(fake.state.children[0]?.display_name).toBe("Mia");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).patch("/api/children/does-not-exist").set(auth()).send({ displayName: "Mia" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/children/:id", () => {
  it("deletes the caller's child", async () => {
    const id = (await createChild({ displayName: "Mia", ageBand: "1-2" })).body.data.id;
    const res = await request(app).delete(`/api/children/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
    expect(fake.state.children).toHaveLength(0);
  });

  it("returns 404 for another user's child and does not delete it", async () => {
    const id = (await createChild({ displayName: "Mia", ageBand: "1-2" })).body.data.id;
    const res = await request(app).delete(`/api/children/${id}`).set(auth(BOB));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(fake.state.children).toHaveLength(1);
  });
});

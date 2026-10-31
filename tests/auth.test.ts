import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));

const { default: app } = await import("../src/app.js");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "parent@example.test", role: "parent" };
const PASSWORD = "correct horse battery";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function setCookies(res: request.Response): string[] {
  const h = res.headers["set-cookie"] as unknown;
  return Array.isArray(h) ? (h as string[]) : typeof h === "string" ? [h] : [];
}

function refreshCookie(res: request.Response): string | undefined {
  const raw = setCookies(res).find((c) => c.startsWith("refresh_token="));
  return raw?.split(";")[0]?.slice("refresh_token=".length);
}

async function login() {
  const res = await request(app).post("/api/auth/login").send({ email: USER.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { res, cookie: refreshCookie(res) as string, accessToken: res.body.data.accessToken as string };
}

const refresh = (cookie: string) => request(app).post("/api/auth/refresh").set("Cookie", `refresh_token=${cookie}`);

beforeEach(() => {
  fake.reset();
  fake.state.users.push({ ...USER, password_hash: bcrypt.hashSync(PASSWORD, 4) });
});

describe("POST /api/auth/login", () => {
  it("returns an access token + user and sets a hardened refresh cookie", async () => {
    const { res, cookie } = await login();
    expect(res.body).toEqual({
      data: { accessToken: expect.any(String), user: USER },
      error: null,
      meta: {},
    });
    const raw = setCookies(res).find((c) => c.startsWith("refresh_token=")) ?? "";
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).not.toMatch(/Secure/i); // NODE_ENV=test
    expect(raw).toMatch(/Max-Age=604800/);

    // Only the hash is stored server-side.
    expect(fake.state.refresh_tokens).toHaveLength(1);
    expect(fake.state.refresh_tokens[0]?.token_hash).toBe(sha256(cookie));
    expect(JSON.stringify(fake.state.refresh_tokens)).not.toContain(cookie);
  });

  it("issues a 15m access token", async () => {
    const { accessToken } = await login();
    const p = jwt.decode(accessToken) as jwt.JwtPayload;
    expect(p.sub).toBe(USER.id);
    expect((p.exp ?? 0) - (p.iat ?? 0)).toBe(15 * 60);
  });

  it("returns the same 401 INVALID_CREDENTIALS for wrong password and unknown email", async () => {
    const wrong = await request(app).post("/api/auth/login").send({ email: USER.email, password: "nope-nope" });
    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.test", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        data: null,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        meta: {},
      });
      expect(refreshCookie(res)).toBeUndefined();
    }
    expect(fake.state.refresh_tokens).toHaveLength(0);
  });

  it("returns 400 VALIDATION for a malformed body", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.data).toBeNull();
  });
});

describe("POST /api/auth/refresh", () => {
  it("returns 401 UNAUTHORIZED without a cookie", async () => {
    const res = await request(app).post("/api/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ data: null, error: { code: "UNAUTHORIZED", message: expect.any(String) }, meta: {} });
  });

  it("returns 401 for a forged cookie", async () => {
    const res = await refresh("not.a.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rotates: new cookie, old token revoked, same family", async () => {
    const { cookie: c1 } = await login();
    const res = await refresh(c1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { accessToken: expect.any(String), user: USER }, error: null, meta: {} });

    const c2 = refreshCookie(res) as string;
    expect(c2).toBeTruthy();
    expect(c2).not.toBe(c1);

    const rows = fake.state.refresh_tokens;
    const old = rows.find((r) => r.token_hash === sha256(c1));
    const next = rows.find((r) => r.token_hash === sha256(c2));
    expect(old?.revoked_at).not.toBeNull();
    expect(next?.revoked_at).toBeNull();
    expect(next?.family_id).toBe(old?.family_id);

    expect((await refresh(c2)).status).toBe(200);
  });

  it("detects reuse of a rotated token and revokes the whole family", async () => {
    const { cookie: c1 } = await login();
    const c2 = refreshCookie(await refresh(c1)) as string;

    const replay = await refresh(c1);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHORIZED");
    expect(fake.state.refresh_tokens.every((r) => r.revoked_at !== null)).toBe(true);

    // The legitimate successor is dead too.
    expect((await refresh(c2)).status).toBe(401);
  });

  it("does not touch other login families on reuse", async () => {
    const { cookie: a1 } = await login();
    const { cookie: b1 } = await login();
    await refresh(a1);
    await refresh(a1); // reuse in family A
    expect((await refresh(b1)).status).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the token, clears the cookie, and returns 200 null", async () => {
    const { cookie } = await login();
    const res = await request(app).post("/api/auth/logout").set("Cookie", `refresh_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });

    const cleared = setCookies(res).find((c) => c.startsWith("refresh_token=")) ?? "";
    expect(cleared).toMatch(/^refresh_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\/api\/auth/);

    expect(fake.state.refresh_tokens[0]?.revoked_at).not.toBeNull();
    expect((await refresh(cookie)).status).toBe(401);
  });

  it("returns 200 without a cookie", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null, error: null, meta: {} });
  });
});

describe("GET /api/auth/me", () => {
  it("requires a JWT", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ data: null, error: { code: "UNAUTHORIZED", message: expect.any(String) }, meta: {} });
  });

  it("rejects garbage and refresh tokens used as access tokens", async () => {
    const { cookie } = await login();
    for (const token of ["garbage", cookie]) {
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it("returns the user for a valid access token", async () => {
    const { accessToken } = await login();
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: USER, error: null, meta: {} });
  });
});

// Invite-only accounts: admin invites, invite lookup, register, roles.
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createFakeDb } from "./helpers/fakeDb.js";
import type { MockEmailProvider } from "../src/providers/email/mock.js";
import { ProviderError } from "../src/providers/errors.js";

const fake = createFakeDb();
vi.mock("../src/lib/db.js", () => ({ db: fake.db }));
// These tests fail registration on purpose many times; the limiter has its own test file.
vi.mock("../src/middleware/rateLimit.js", async (importActual) => ({
  ...(await importActual<object>()),
  registerLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { default: app } = await import("../src/app.js");
const { getEmailProvider } = await import("../src/providers/index.js");
const mailer = getEmailProvider() as MockEmailProvider; // EMAIL_PROVIDER=mock in vitest.config.ts

vi.setConfig({ testTimeout: 30_000 }); // register hashes with a real cost-12 bcrypt

type U = { id: string; email: string; role: "admin" | "parent" };
const ADMIN: U = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "admin@example.test", role: "admin" };
const PARENT: U = { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "parent@example.test", role: "parent" };
const PASSWORD = "admin password 123";
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const auth = (u: U) => ({
  Authorization: `Bearer ${jwt.sign({ email: u.email, role: u.role }, process.env.JWT_SECRET as string, { subject: u.id, expiresIn: 900 })}`,
});

const invite = (email: string) => request(app).post("/api/invites").set(auth(ADMIN)).send({ email });
const tokenOf = (inviteUrl: string) => new URL(inviteUrl).searchParams.get("token") as string;
const lookup = (token: string) => request(app).get(`/api/auth/invites/${encodeURIComponent(token)}`);
const register = (body: object) => request(app).post("/api/auth/register").send(body);
const NOT_FOUND = { data: null, error: { code: "NOT_FOUND", message: "This invite link is invalid or has expired" }, meta: {} };

function refreshCookieHeader(res: request.Response): string {
  const h = res.headers["set-cookie"] as unknown;
  const all = Array.isArray(h) ? (h as string[]) : typeof h === "string" ? [h] : [];
  return all.find((c) => c.startsWith("refresh_token=")) ?? "";
}

beforeEach(() => {
  fake.reset();
  mailer.sent.length = 0;
  vi.restoreAllMocks();
  const hash = bcrypt.hashSync(PASSWORD, 4);
  fake.state.users.push({ ...ADMIN, password_hash: hash }, { ...PARENT, password_hash: hash });
});

describe("roles", () => {
  it("login / me return the role, and the access JWT carries it", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: ADMIN.email, password: PASSWORD });
    expect(res.body.data.user).toEqual(ADMIN);
    expect((jwt.decode(res.body.data.accessToken) as jwt.JwtPayload).role).toBe("admin");
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.body.data).toEqual(ADMIN);
  });

  it("admin-only routes → 403 FORBIDDEN for a parent (and for a token without a role), 401 without a token", async () => {
    const roleless = { Authorization: `Bearer ${jwt.sign({ email: "x@example.test" }, process.env.JWT_SECRET as string, { subject: ADMIN.id })}` };
    const calls = [
      (h: Record<string, string>) => request(app).post("/api/invites").set(h).send({ email: "new@example.test" }),
      (h: Record<string, string>) => request(app).get("/api/invites").set(h),
      (h: Record<string, string>) => request(app).delete("/api/invites/whatever").set(h),
      (h: Record<string, string>) => request(app).delete("/api/catalog/whatever").set(h),
    ];
    for (const call of calls) {
      for (const h of [auth(PARENT), roleless]) {
        const res = await call(h);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ data: null, error: { code: "FORBIDDEN", message: expect.any(String) }, meta: {} });
      }
      expect((await call({})).status).toBe(401);
    }
    expect(fake.state.invites).toHaveLength(0);
  });
});

describe("POST /api/invites", () => {
  it("201 Invite & { inviteUrl }; stores only the token's SHA-256 hash; 7-day expiry", async () => {
    const res = await invite("  New.Parent@Example.test ");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: {
        id: expect.any(String), email: "new.parent@example.test", status: "pending",
        createdAt: expect.any(String), expiresAt: expect.any(String),
        inviteUrl: expect.stringMatching(/^http:\/\/localhost:3000\/signup\?token=[A-Za-z0-9_-]{43}$/),
        emailStatus: "sent",
      },
      error: null,
      meta: {},
    });
    const token = tokenOf(res.body.data.inviteUrl);
    const ttl = Date.parse(res.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(7 * DAY - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * DAY);
    expect(fake.state.invites).toEqual([expect.objectContaining({ email: "new.parent@example.test", token_hash: sha256(token), created_by: ADMIN.id })]);
    expect(JSON.stringify(fake.state.invites)).not.toContain(token);
    // The raw token is never returned again.
    expect(JSON.stringify((await request(app).get("/api/invites").set(auth(ADMIN))).body)).not.toContain(token);
  });

  it("409 CONFLICT when the email already has an account (any case)", async () => {
    const res = await invite("PARENT@example.test");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(fake.state.invites).toHaveLength(0);
  });

  it("400 VALIDATION for a bad email", async () => {
    const res = await invite("not-an-email");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "VALIDATION", message: expect.stringContaining("email") });
  });

  it("re-inviting an email revokes its older pending invite", async () => {
    const first = await invite("new@example.test");
    const second = await invite("new@example.test");
    expect(second.status).toBe(201);
    expect((await lookup(tokenOf(first.body.data.inviteUrl))).status).toBe(404);
    expect((await lookup(tokenOf(second.body.data.inviteUrl))).body.data).toEqual({ email: "new@example.test" });
    const list = (await request(app).get("/api/invites").set(auth(ADMIN))).body.data;
    expect(list.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([
      [second.body.data.id, "pending"],
      [first.body.data.id, "revoked"],
    ]);
  });
});

describe("GET /api/invites + DELETE /api/invites/:id", () => {
  it("lists newest first with pending / used / expired / revoked statuses", async () => {
    const ids: string[] = [];
    for (const e of ["a@example.test", "b@example.test", "c@example.test", "d@example.test"]) ids.push((await invite(e)).body.data.id);
    const row = (id: string) => fake.state.invites.find((i) => i.id === id) as Record<string, unknown>;
    row(ids[0] as string).used_at = new Date();
    row(ids[1] as string).expires_at = new Date(Date.now() - 1000);
    row(ids[2] as string).revoked_at = new Date();

    const res = await request(app).get("/api/invites").set(auth(ADMIN));
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 4 });
    expect(res.body.data.map((i: { email: string; status: string }) => `${i.email}:${i.status}`)).toEqual([
      "d@example.test:pending",
      "c@example.test:revoked",
      "b@example.test:expired",
      "a@example.test:used",
    ]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "status"]);
  });

  it("revokes a pending invite (its link then 404s); used / expired / revoked → 409; unknown → 404", async () => {
    const created = (await invite("new@example.test")).body.data;
    const del = await request(app).delete(`/api/invites/${created.id}`).set(auth(ADMIN));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ data: null, error: null, meta: {} });
    expect((await lookup(tokenOf(created.inviteUrl))).status).toBe(404);

    const again = await request(app).delete(`/api/invites/${created.id}`).set(auth(ADMIN));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");

    for (const [email, patch] of [
      ["used@example.test", { used_at: new Date() }],
      ["old@example.test", { expires_at: new Date(Date.now() - 1000) }],
    ] as const) {
      const id = (await invite(email)).body.data.id as string;
      Object.assign(fake.state.invites.find((i) => i.id === id) as object, patch);
      const res = await request(app).delete(`/api/invites/${id}`).set(auth(ADMIN));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    }
    expect((await request(app).delete("/api/invites/nope").set(auth(ADMIN))).status).toBe(404);
  });
});

describe("GET /api/auth/invites/:token", () => {
  it("returns { email } for a pending invite, without auth", async () => {
    const created = (await invite("new@example.test")).body.data;
    const res = await lookup(tokenOf(created.inviteUrl));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { email: "new@example.test" }, error: null, meta: {} });
  });

  it("unknown, expired, used and malformed tokens all answer the same 404 NOT_FOUND", async () => {
    const expired = (await invite("old@example.test")).body.data;
    (fake.state.invites[0] as Record<string, unknown>).expires_at = new Date(Date.now() - 1000);
    const used = (await invite("used@example.test")).body.data;
    (fake.state.invites[1] as Record<string, unknown>).used_at = new Date();

    for (const token of [tokenOf(expired.inviteUrl), tokenOf(used.inviteUrl), "unknown-token", "x".repeat(500), "%%%"]) {
      const res = await lookup(token);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
  });
});

describe("POST /api/auth/register", () => {
  async function pendingToken(email = "new@example.test") {
    return tokenOf((await invite(email)).body.data.inviteUrl);
  }

  it("creates a parent from the invite, marks it used, and sets the refresh cookie exactly like login", async () => {
    const token = await pendingToken();
    const res = await register({ token, password: "a long enough pw", email: "ignored@example.test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { accessToken: expect.any(String), user: { id: expect.any(String), email: "new@example.test", role: "parent" } },
      error: null,
      meta: {},
    });
    expect((jwt.decode(res.body.data.accessToken) as jwt.JwtPayload).role).toBe("parent");

    const cookie = refreshCookieHeader(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Max-Age=604800/);
    const raw = cookie.split(";")[0]?.slice("refresh_token=".length) as string;
    expect(fake.state.refresh_tokens).toEqual([expect.objectContaining({ user_id: res.body.data.user.id, token_hash: sha256(raw) })]);

    const user = fake.state.users.find((u) => u.email === "new@example.test") as Record<string, unknown>;
    expect(user.role).toBe("parent");
    expect(String(user.password_hash)).toMatch(/^\$2[aby]\$12\$/); // bcrypt cost 12
    expect(fake.state.invites[0]?.used_at).not.toBeNull();

    // Single use; the new account can log in with its password.
    expect((await register({ token, password: "a long enough pw" })).body).toEqual(NOT_FOUND);
    expect((await lookup(token)).status).toBe(404);
    const login = await request(app).post("/api/auth/login").send({ email: "new@example.test", password: "a long enough pw" });
    expect(login.body.data.user.role).toBe("parent");
  });

  it("bad, expired, revoked or malformed token → 404 NOT_FOUND; nothing created", async () => {
    const expired = await pendingToken("old@example.test");
    (fake.state.invites[0] as Record<string, unknown>).expires_at = new Date(Date.now() - 1000);
    for (const token of ["unknown-token", expired, "", "x".repeat(500), 12345, null, undefined]) {
      const res = await register({ token, password: "a long enough pw" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect(fake.state.users).toHaveLength(2);
  });

  it("password must be 10-128 characters → 400 VALIDATION; invite stays usable", async () => {
    const token = await pendingToken();
    for (const password of ["short pw!", "x".repeat(129), undefined]) {
      const res = await register({ token, password });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: "VALIDATION", message: expect.stringContaining("password") });
    }
    expect(fake.state.invites[0]?.used_at).toBeNull();
    expect((await lookup(token)).status).toBe(200);
  });

  it("409 CONFLICT when the email got an account after the invite; invite left unused", async () => {
    const token = await pendingToken();
    fake.state.users.push({ id: "cccccccc-0000-4000-8000-000000000003", email: "NEW@example.test", role: "parent", password_hash: "x" });
    const res = await register({ token, password: "a long enough pw" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(fake.state.invites[0]?.used_at).toBeNull();
    expect(fake.state.refresh_tokens).toHaveLength(0);
  });
});

describe("POST /api/invites — invite email", () => {
  function captureLogs() {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    return lines;
  }

  it("sends one email to the invited address with the link in both parts; logs only id + message id", async () => {
    const logs = captureLogs();
    const res = await invite("New.Parent@Example.test");
    expect(res.status).toBe(201);
    expect(res.body.data.emailStatus).toBe("sent");

    const { inviteUrl, id } = res.body.data as { inviteUrl: string; id: string };
    const token = tokenOf(inviteUrl);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe("new.parent@example.test");
    expect(mail.subject).toBe("You're invited to LittleEars");
    expect(mail.text).toContain(inviteUrl);
    expect(mail.html).toContain(`href="${inviteUrl}"`);
    // From the inviting admin (invites.created_by): named in both parts and used as Reply-To.
    expect(mail.replyTo).toBe(ADMIN.email);
    expect(mail.text).toContain(`${ADMIN.email} invited you to LittleEars`);
    expect(mail.html).toContain(`<strong>${ADMIN.email}</strong> invited you to LittleEars`);

    const joined = logs.join("\n");
    expect(joined).toContain(`invite ${id} email sent (message ${mail.id})`);
    for (const secret of [token, inviteUrl, "new.parent@example.test", ADMIN.email, mail.text]) expect(joined).not.toContain(secret);
  });

  it("provider failure → still 201 with emailStatus 'failed'; the invite stays pending and usable; no secrets logged", async () => {
    const logs = captureLogs();
    vi.spyOn(mailer, "send").mockRejectedValueOnce(new ProviderError("resend", "PROVIDER_REJECTED", false));
    const res = await invite("new@example.test");
    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toMatchObject({ email: "new@example.test", status: "pending", emailStatus: "failed" });

    const token = tokenOf(res.body.data.inviteUrl);
    expect(fake.state.invites).toHaveLength(1);
    expect((await lookup(token)).body.data).toEqual({ email: "new@example.test" });

    const joined = logs.join("\n");
    expect(joined).toContain(`invite ${res.body.data.id} email failed (PROVIDER_REJECTED)`);
    for (const secret of [token, res.body.data.inviteUrl, "new@example.test", ADMIN.email]) expect(joined).not.toContain(secret);
  });

  it("an unexpected (non-provider) send error is also emailStatus 'failed'", async () => {
    captureLogs();
    vi.spyOn(mailer, "send").mockRejectedValueOnce(new Error("boom to new@example.test"));
    const res = await invite("new@example.test");
    expect(res.status).toBe(201);
    expect(res.body.data.emailStatus).toBe("failed");
  });

  it("re-inviting sends a new email with a different token; only the newest link works", async () => {
    captureLogs();
    const first = (await invite("new@example.test")).body.data;
    const second = (await invite("new@example.test")).body.data;
    expect(mailer.sent.map((m) => m.to)).toEqual(["new@example.test", "new@example.test"]);
    expect(tokenOf(first.inviteUrl)).not.toBe(tokenOf(second.inviteUrl));
    expect(mailer.sent[0]!.text).toContain(first.inviteUrl);
    expect(mailer.sent[1]!.text).toContain(second.inviteUrl);
    expect(mailer.sent[1]!.text).not.toContain(tokenOf(first.inviteUrl));
  });

  it("no email for a rejected invite (409 existing account / 400 bad email)", async () => {
    await invite("PARENT@example.test");
    await invite("not-an-email");
    expect(mailer.sent).toHaveLength(0);
  });
});

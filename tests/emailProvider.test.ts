// EmailProvider: env rules, registry selection, Resend adapter (SDK client faked — no network),
// vendor error mapping, mock recording.
import { describe, it, expect, vi } from "vitest";
import { parseEnv } from "../src/lib/env.js";
import { createEmailProvider } from "../src/providers/index.js";
import { MockEmailProvider } from "../src/providers/email/mock.js";
import { ResendEmailProvider, toResendProviderError } from "../src/providers/email/resend.js";
import { ProviderError } from "../src/providers/errors.js";

const MSG = { to: "parent@example.test", subject: "You're invited to LittleEars", html: "<p>hi</p>", text: "hi" };
const FROM = "LittleEars <onboarding@resend.dev>";

describe("env: EMAIL_PROVIDER / RESEND_API_KEY / EMAIL_FROM", () => {
  // vitest.config.ts env is a complete, valid base (mock providers).
  const base = { ...process.env, EMAIL_PROVIDER: undefined, RESEND_API_KEY: undefined, EMAIL_FROM: undefined };

  it("defaults: mock without a key, resend with one; EMAIL_FROM default", () => {
    expect(parseEnv({ ...base, NODE_ENV: "development" }).EMAIL_PROVIDER).toBe("mock");
    const withKey = parseEnv({ ...base, NODE_ENV: "development", RESEND_API_KEY: "re_test" });
    expect(withKey.EMAIL_PROVIDER).toBe("resend");
    expect(withKey.EMAIL_FROM).toBe(FROM);
    expect(parseEnv({ ...base, RESEND_API_KEY: "re_test", EMAIL_PROVIDER: "mock" }).EMAIL_PROVIDER).toBe("mock");
    expect(parseEnv({ ...base, EMAIL_FROM: "Kids <hi@example.test>" }).EMAIL_FROM).toBe("Kids <hi@example.test>");
  });

  it("resend requires RESEND_API_KEY; production requires resend; errors never echo values", () => {
    expect(() => parseEnv({ ...base, EMAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY/);
    const prod = { ...base, NODE_ENV: "production", APP_URL: "https://app.example.test" };
    expect(() => parseEnv(prod)).toThrow(/EMAIL_PROVIDER/);
    expect(() => parseEnv({ ...prod, EMAIL_PROVIDER: "mock", RESEND_API_KEY: "re_secret_value" })).toThrow(/EMAIL_PROVIDER/);
    try {
      parseEnv({ ...prod, EMAIL_PROVIDER: "mock", RESEND_API_KEY: "re_secret_value" });
    } catch (err) {
      expect(String(err)).not.toContain("re_secret_value");
    }
    expect(parseEnv({ ...prod, RESEND_API_KEY: "re_test" }).EMAIL_PROVIDER).toBe("resend");
  });
});

describe("email provider registry", () => {
  it("selects mock or resend from EMAIL_PROVIDER; resend needs a key", () => {
    expect(createEmailProvider({ EMAIL_PROVIDER: "mock", EMAIL_FROM: FROM })).toBeInstanceOf(MockEmailProvider);
    expect(createEmailProvider({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FROM: FROM })).toBeInstanceOf(ResendEmailProvider);
    expect(() => createEmailProvider({ EMAIL_PROVIDER: "resend", EMAIL_FROM: FROM })).toThrow(/RESEND_API_KEY/);
  });
});

describe("MockEmailProvider", () => {
  it("records each send (incl. replyTo) and returns distinct ids", async () => {
    const m = new MockEmailProvider();
    const a = await m.send({ ...MSG, replyTo: "admin@example.test" });
    const b = await m.send({ ...MSG, to: "other@example.test" });
    expect(a.id).not.toBe(b.id);
    expect(m.sent).toEqual([{ ...MSG, replyTo: "admin@example.test", id: a.id }, { ...MSG, to: "other@example.test", id: b.id }]);
  });
});

describe("ResendEmailProvider", () => {
  const fakeClient = (result: unknown) => {
    const send = vi.fn().mockResolvedValue(result);
    return { send, client: { emails: { send } } as unknown as ConstructorParameters<typeof ResendEmailProvider>[0]["client"] };
  };

  it("calls emails.send({ from, to, subject, html, text }, { signal }) and returns the message id", async () => {
    const { send, client } = fakeClient({ data: { id: "msg_123" }, error: null, headers: null });
    const p = new ResendEmailProvider({ apiKey: "re_test", from: FROM, client });
    expect(await p.send(MSG)).toEqual({ id: "msg_123" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ from: FROM, ...MSG }, { signal: expect.any(AbortSignal) });
  });

  it("passes replyTo through as the SDK's `replyTo` field", async () => {
    const { send, client } = fakeClient({ data: { id: "msg_456" }, error: null, headers: null });
    const p = new ResendEmailProvider({ apiKey: "re_test", from: FROM, client });
    await p.send({ ...MSG, replyTo: "admin@example.test" });
    expect(send).toHaveBeenCalledWith({ from: FROM, ...MSG, replyTo: "admin@example.test" }, { signal: expect.any(AbortSignal) });
  });

  it("maps a returned Resend error to a ProviderError without the vendor message", async () => {
    const { client } = fakeClient({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "You can only send testing emails to your own email address (owner@x.test)" },
      headers: null,
    });
    const p = new ResendEmailProvider({ apiKey: "re_test", from: FROM, client });
    const err = await p.send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "PROVIDER_REJECTED", vendor: "resend", transient: false });
    expect((err as Error).message).not.toMatch(/owner@x\.test|parent@example\.test/);
  });

  it("maps a thrown SDK error too", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    const p = new ResendEmailProvider({ apiKey: "re_test", from: FROM, client: { emails: { send } } as never });
    await expect(p.send(MSG)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", vendor: "resend" });
  });

  it("error mapping table", () => {
    const cases: [string, number | null, string, boolean][] = [
      ["daily_quota_exceeded", 429, "PROVIDER_QUOTA", false],
      ["monthly_quota_exceeded", 429, "PROVIDER_QUOTA", false],
      ["rate_limit_exceeded", 429, "PROVIDER_QUOTA", true],
      ["application_error", null, "PROVIDER_UNAVAILABLE", true], // network failure / timeout
      ["internal_server_error", 500, "PROVIDER_UNAVAILABLE", true],
      ["application_error", 502, "PROVIDER_UNAVAILABLE", true],
      ["invalid_api_key", 403, "PROVIDER_UNAVAILABLE", false],
      ["missing_api_key", 401, "PROVIDER_UNAVAILABLE", false],
      ["restricted_api_key", 401, "PROVIDER_UNAVAILABLE", false],
      ["validation_error", 422, "PROVIDER_REJECTED", false],
      ["invalid_from_address", 422, "PROVIDER_REJECTED", false],
      ["validation_error", 403, "PROVIDER_REJECTED", false], // unverified domain / test-sender restriction
    ];
    for (const [name, statusCode, code, transient] of cases) {
      const e = toResendProviderError({ name, statusCode, message: "x" });
      expect([name, statusCode, e.code, e.transient]).toEqual([name, statusCode, code, transient]);
    }
  });
});

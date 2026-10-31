// Vendor error → internal error mapping (R5). Duck-typed on the fields every SDK we use
// exposes (`status` / `statusCode`, `code`, `name`, body/message), so no vendor SDK is
// imported here and adapters stay swappable.
import { AppError } from "../lib/errors.js";

export type Vendor = "openai" | "elevenlabs" | "gemini" | "resend";
export type ProviderErrorCode = "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "PROVIDER_QUOTA";

const HTTP_STATUS: Record<ProviderErrorCode, number> = {
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_REJECTED: 422,
  PROVIDER_QUOTA: 503,
};

const MESSAGES: Record<ProviderErrorCode, string> = {
  PROVIDER_UNAVAILABLE: "provider is unavailable",
  PROVIDER_REJECTED: "provider rejected the request",
  PROVIDER_QUOTA: "provider quota or rate limit reached",
};

/**
 * `transient` = worth retrying with backoff (the worker uses it). The message is generic on
 * purpose: vendor messages can echo prompts, which may contain a child's name (R4).
 */
export class ProviderError extends AppError {
  readonly vendor: Vendor;
  readonly transient: boolean;

  constructor(vendor: Vendor, code: ProviderErrorCode, transient: boolean, detail?: string, options?: { cause?: unknown }) {
    super(HTTP_STATUS[code], code, `${vendor} ${detail ?? MESSAGES[code]}`);
    this.name = "ProviderError";
    this.vendor = vendor;
    this.transient = transient;
    if (options?.cause !== undefined) Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
  }
}

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+)$/;
const QUOTA_TEXT = /quota|billing|insufficient|credit|payment|RESOURCE_EXHAUSTED/i;
const POLICY_TEXT = /policy|safety|moderat|content_filter|bad_prompt|bad_composition_plan|blocked/i;

function field(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
}

function statusOf(err: unknown): number | undefined {
  for (const key of ["status", "statusCode"]) {
    const v = field(err, key);
    if (typeof v === "number" && v >= 100) return v;
  }
  return undefined;
}

/** Every text the SDKs put error details in: message, code, type, body, nested error. */
function textOf(err: unknown): string {
  const parts = [field(err, "message"), field(err, "code"), field(err, "type"), field(err, "body"), field(err, "error")];
  return parts.map((p) => (typeof p === "string" ? p : p === undefined ? "" : safeJson(p))).join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function isNetworkOrTimeout(err: unknown): boolean {
  // Some SDK errors keep name "Error" (e.g. OpenAI's APIConnectionTimeoutError) — check the class name too.
  const ctor = typeof err === "object" && err !== null ? err.constructor?.name : "";
  const name = `${String(field(err, "name") ?? "")} ${ctor ?? ""}`;
  if (/timeout|abort|connection/i.test(name)) return true;
  const codes = [field(err, "code"), field(field(err, "cause"), "code")];
  if (codes.some((c) => typeof c === "string" && NETWORK_CODES.test(c))) return true;
  return /TypeError/.test(name) && /fetch failed|network/i.test(String(field(err, "message") ?? ""));
}

export function toProviderError(vendor: Vendor, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const make = (code: ProviderErrorCode, transient: boolean) => new ProviderError(vendor, code, transient, undefined, { cause: err });

  const status = statusOf(err);
  const text = textOf(err);

  if (status === undefined) {
    // No HTTP response: network failure, timeout, or a non-HTTP SDK error.
    return make("PROVIDER_UNAVAILABLE", isNetworkOrTimeout(err));
  }
  // Quota/billing exhaustion is not retryable; plain 429 rate limiting is.
  // (ElevenLabs reports exhausted credits as 401 `quota_exceeded`; OpenAI as 429 `insufficient_quota`.)
  if (status === 402 || QUOTA_TEXT.test(text)) return make("PROVIDER_QUOTA", false);
  if (status === 429) return make("PROVIDER_QUOTA", true);
  if (status === 408 || status >= 500) return make("PROVIDER_UNAVAILABLE", true);
  // Bad API key / permissions: the provider is unusable until config is fixed.
  if (status === 401 || status === 403) {
    return POLICY_TEXT.test(text) ? make("PROVIDER_REJECTED", false) : make("PROVIDER_UNAVAILABLE", false);
  }
  // Remaining 4xx: validation or content-policy rejection.
  return make("PROVIDER_REJECTED", false);
}

/** Runs one vendor call and maps anything it throws. */
export async function callVendor<T>(vendor: Vendor, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toProviderError(vendor, err);
  }
}

/** Collects an SDK audio stream into a Buffer. */
export async function readAll(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

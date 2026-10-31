// Resend EmailProvider. SDK verified 2026-10-31 against resend@6.37 typings/README:
//   new Resend(apiKey); resend.emails.send({ from, to, subject, html, text, replyTo? }, { signal })
//   (`replyTo?: string | string[]` in CreateEmailBaseOptions; the SDK sends it as reply_to)
//   → { data: { id }, error: null } | { data: null, error: { name, statusCode, message } }.
// The SDK does not throw for HTTP or network failures: it returns `error` (statusCode null when no
// response arrived, incl. an aborted request), so both paths are mapped here.
import { Resend } from "resend";
import { ProviderError, callVendor } from "../errors.js";
import type { EmailMessage, EmailProvider } from "./types.js";

const SEND_TIMEOUT_MS = 15_000;

export type ResendErrorBody = { name: string; statusCode: number | null; message: string };
type EmailsClient = Pick<Resend, "emails">;

const AUTH_ERRORS = new Set(["missing_api_key", "invalid_api_key", "restricted_api_key"]);

/**
 * Maps a Resend error body to a ProviderError. The vendor message is dropped on purpose: it can
 * echo the recipient address (e.g. the test-sender restriction).
 */
export function toResendProviderError(e: ResendErrorBody): ProviderError {
  const s = e.statusCode;
  if (e.name === "daily_quota_exceeded" || e.name === "monthly_quota_exceeded") {
    return new ProviderError("resend", "PROVIDER_QUOTA", false);
  }
  if (e.name === "rate_limit_exceeded" || s === 429) return new ProviderError("resend", "PROVIDER_QUOTA", true);
  if (s === null || s === 408 || s >= 500) return new ProviderError("resend", "PROVIDER_UNAVAILABLE", true);
  // Bad/missing key: unusable until config is fixed.
  if (AUTH_ERRORS.has(e.name) || s === 401) return new ProviderError("resend", "PROVIDER_UNAVAILABLE", false);
  // Remaining 4xx: validation, unverified sender/domain, test-sender recipient restriction.
  return new ProviderError("resend", "PROVIDER_REJECTED", false);
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: EmailsClient;
  private readonly from: string;

  constructor(opts: { apiKey: string; from: string; client?: EmailsClient }) {
    this.client = opts.client ?? new Resend(opts.apiKey);
    this.from = opts.from;
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const res = await callVendor("resend", () =>
      this.client.emails.send(
        {
          from: this.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        },
        { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
      ),
    );
    if (res.error) throw toResendProviderError(res.error);
    return { id: res.data.id };
  }
}

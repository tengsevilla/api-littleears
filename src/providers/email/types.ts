// EmailProvider (invite emails). Callers depend only on this; the Resend SDK stays in ./resend.ts (R5).

/** `replyTo`: where replies go (the inviting admin), so they reach a person, not the sender address. */
export type EmailMessage = { to: string; subject: string; html: string; text: string; replyTo?: string };

export interface EmailProvider {
  /** Sends one email. Resolves with the provider's message id; throws ProviderError on failure. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

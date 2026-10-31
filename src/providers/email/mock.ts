// Mock EmailProvider (R5): no network. Records every message so tests can inspect what was sent.
import type { EmailMessage, EmailProvider } from "./types.js";

export class MockEmailProvider implements EmailProvider {
  readonly sent: (EmailMessage & { id: string })[] = [];

  async send(message: EmailMessage): Promise<{ id: string }> {
    const id = `mock-email-${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    return { id };
  }
}

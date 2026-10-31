// Invite email template: rendered subject / HTML / text. Pure function, no I/O.
import { describe, it, expect } from "vitest";
import { formatExpiryUtc, renderInviteEmail } from "../src/lib/emails/invite.js";

const URL_ = "http://localhost:3000/signup?token=AbC-def_123";
const EXPIRES = new Date("2026-11-07T15:04:09Z"); // a Saturday

describe("renderInviteEmail", () => {
  const INVITER = `ad"min&<b>@example.test`;
  const mail = renderInviteEmail({ email: "o'neil+<kid>@example.test", inviterEmail: INVITER, inviteUrl: URL_, expiresAt: EXPIRES });

  it("says who invited them in the intro line (HTML-escaped in the HTML part)", () => {
    expect(mail.text).toContain(`${INVITER} invited you to LittleEars`);
    expect(mail.html).toContain("<strong>ad&quot;min&amp;&lt;b&gt;@example.test</strong> invited you to LittleEars");
    expect(mail.html).not.toContain(INVITER);
    for (const part of [mail.text, mail.html]) expect(part).toContain("reply to this email");
  });

  it("has the contract subject", () => {
    expect(mail.subject).toBe("You're invited to LittleEars");
  });

  it("puts the link in both parts: a button and the raw link as text", () => {
    expect(mail.text).toContain(`\n${URL_}\n`);
    expect(mail.html.match(new RegExp(`href="${URL_.replace(/[?]/g, "\\?")}"`, "g"))).toHaveLength(2);
    expect(mail.html).toContain("Create my account</a>");
    expect(mail.html).toContain(`>${URL_}</a>`);
  });

  it("HTML-escapes the email address (text part keeps it plain)", () => {
    expect(mail.html).toContain("o&#39;neil+&lt;kid&gt;@example.test");
    expect(mail.html).not.toContain("<kid>");
    expect(mail.text).toContain("o'neil+<kid>@example.test");
  });

  it("says it works once and when it expires, in plain English UTC", () => {
    const line = "This link works once and expires in 7 days, on Saturday, 7 November 2026 at 15:04 UTC.";
    expect(mail.text).toContain(line);
    expect(mail.html).toContain("Saturday, 7 November 2026 at 15:04 UTC");
    expect(mail.html).toContain("works once");
  });

  it("says that an unexpected invite can be ignored", () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toMatch(/weren(&#39;|')t expecting this invite, you can safely ignore this email/);
    }
  });

  it("has no external images, scripts, stylesheets or tracking", () => {
    expect(mail.html).not.toMatch(/<img|<script|<link|url\(|background=/i);
    // The only URLs in the HTML are the invite link.
    const urls = mail.html.match(/https?:\/\/[^\s"<]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([URL_]));
  });
});

describe("formatExpiryUtc", () => {
  it("formats in UTC with zero-padded time", () => {
    expect(formatExpiryUtc(new Date("2027-01-03T05:07:00Z"))).toBe("Sunday, 3 January 2027 at 05:07 UTC");
    // 23:30 in UTC−5 is already the next day in UTC.
    expect(formatExpiryUtc(new Date("2026-12-31T23:30:00-05:00"))).toBe("Friday, 1 January 2027 at 04:30 UTC");
  });
});

// Invite email: subject + HTML + plain text. Inline styles only, no images, no tracking.
// Pure (no I/O) so it can be unit-tested; the caller sends it through the EmailProvider.

export const INVITE_SUBJECT = "You're invited to LittleEars";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Saturday, 7 November 2026 at 15:04 UTC" — built by hand so it never depends on the ICU build. */
export function formatExpiryUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `inviterEmail`: the inviting admin (invites.created_by), named as the sender; the caller also sets it as Reply-To. */
export function renderInviteEmail(input: { email: string; inviterEmail: string; inviteUrl: string; expiresAt: Date }): {
  subject: string;
  html: string;
  text: string;
} {
  const expiry = formatExpiryUtc(input.expiresAt);
  const expiryLine = `This link works once and expires in 7 days, on ${expiry}.`;
  const ignoreLine = "If you weren't expecting this invite, you can safely ignore this email. No account is created unless you use the link.";

  const text = [
    "Hi there,",
    "",
    `${input.inviterEmail} invited you to LittleEars, where you can make gentle, personalized songs for your little one. Questions? Just reply to this email to reach them.`,
    "",
    `Create your account for ${input.email} here:`,
    input.inviteUrl,
    "",
    expiryLine,
    "",
    ignoreLine,
    "",
    "LittleEars",
  ].join("\n");

  const url = escapeHtml(input.inviteUrl);
  const email = escapeHtml(input.email);
  const inviter = escapeHtml(input.inviterEmail);
  const p = "margin:0 0 16px;font-size:16px;line-height:24px;color:#3f3a36;";
  const small = "margin:0 0 12px;font-size:14px;line-height:21px;color:#6b635c;";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(INVITE_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background-color:#fbf7f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fbf7f2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border-radius:16px;">
<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;">
<h1 style="margin:0 0 20px;font-size:24px;line-height:32px;color:#2f2a26;">You're invited to LittleEars</h1>
<p style="${p}">Hi there,</p>
<p style="${p}"><strong>${inviter}</strong> invited you to LittleEars, where you can make gentle, personalized songs for your little one. Questions? Just reply to this email to reach them.</p>
<p style="${p}">Create your account for <strong>${email}</strong>:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
<tr><td align="center" style="border-radius:999px;background-color:#e8743b;">
<a href="${url}" style="display:inline-block;padding:16px 32px;font-size:18px;font-weight:bold;line-height:24px;color:#ffffff;text-decoration:none;border-radius:999px;">Create my account</a>
</td></tr>
</table>
<p style="${small}">Or copy this link into your browser:<br><a href="${url}" style="color:#b4501f;word-break:break-all;">${url}</a></p>
<p style="${small}">${escapeHtml(expiryLine)}</p>
<p style="${small}">${escapeHtml(ignoreLine)}</p>
<p style="margin:24px 0 0;font-size:14px;line-height:21px;color:#6b635c;">LittleEars</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: INVITE_SUBJECT, html, text };
}

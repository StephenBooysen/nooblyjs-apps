// Account emails (verify, reset, invitations, receipts) leave through the customers accelerator's email channel. This
// builds that channel's transport from SMTP_URL (roadmap 8.7.1). Without one, outside production, emails stay in the
// accelerator's console outbox; production refuses to start without one unless EMAIL=off says so on purpose.
import nodemailer from 'nodemailer';

/** SMTP_URL schemes nodemailer takes: smtps:// is TLS from the start (465), smtp:// upgrades with STARTTLS (587). */
const SCHEMES = ['smtp:', 'smtps:'];

/**
 * "NooblyJS Cloud <no-reply@example.com>" or "no-reply@example.com" → { name, address }, or null when it is not an
 * address.
 * @param {string|null|undefined} value
 * @returns {{ address: string, name?: string }|null}
 */
export function parseFrom(value) {
  const text = String(value ?? '').trim();
  const named = text.match(/^"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (named) return { address: named[2], ...(named[1].trim() ? { name: named[1].trim() } : {}) };
  return /^[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+$/.test(text) ? { address: text } : null;
}

/**
 * What is wrong with the email settings, as one message, or null.
 * @param {{ smtpUrl?: string|null, emailFrom?: string|null }} config
 */
export function mailProblem({ smtpUrl, emailFrom }) {
  if (!smtpUrl) return null;
  let url;
  try {
    url = new URL(smtpUrl);
  } catch {
    return 'SMTP_URL is not a URL: smtps://user:password@smtp.example.com:465 (or smtp://… on 587 with STARTTLS).';
  }
  if (!SCHEMES.includes(url.protocol)) return `SMTP_URL must start smtps:// or smtp://, not ${url.protocol}//.`;
  if (!emailFrom) return 'EMAIL_FROM is required with SMTP_URL: the address account emails come from, e.g. "NooblyJS Cloud <no-reply@example.com>".';
  if (!parseFrom(emailFrom)) return `EMAIL_FROM is not an email address: "${emailFrom}".`;
  return null;
}

/**
 * A nodemailer transport for SMTP_URL, or null without one. Passwords in the URL stay in the transport: nothing logs it.
 * @param {{ smtpUrl?: string|null }} config
 */
export function createMailTransport({ smtpUrl }) {
  if (!smtpUrl) return null;
  // smtp:// must upgrade to TLS: a server that does not offer STARTTLS is refused rather than sent passwords in clear.
  const secure = new URL(smtpUrl).protocol === 'smtps:';
  return nodemailer.createTransport(smtpUrl, { requireTLS: !secure, pool: true, maxConnections: 3 });
}

/** Where a transport sends, for the start-up log: host and port, no user or password. */
export function describeTransport(smtpUrl) {
  if (!smtpUrl) return null;
  const url = new URL(smtpUrl);
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
}

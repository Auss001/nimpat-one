import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Logged in development only, so links/tokens never reach production logs. */
  devOnlyDetail?: string;
}

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain, readable HTML copy of the text, with links made clickable. */
function toHtml(text: string): string {
  const body = escapeHtml(text).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#10291e">${body}</div>`;
}

/**
 * Outbound email. MAIL_TRANSPORT chooses where it goes:
 * - "console" logs it (development);
 * - "resend" sends it through Resend, using RESEND_API_KEY and EMAIL_FROM.
 * The API key is read from the environment only, and is never logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(private readonly config: AppConfig) {}

  async send(msg: MailMessage): Promise<void> {
    const transport = this.config.get('MAIL_TRANSPORT');
    if (transport === 'console') {
      const detail = !this.config.isProduction && msg.devOnlyDetail ? `\n    ${msg.devOnlyDetail}` : '';
      this.logger.log(`[console mail] to=${msg.to} subject="${msg.subject}"${detail}`);
      return;
    }
    if (transport === 'resend') return this.sendWithResend(msg);
    // Fail loudly rather than silently drop mail.
    throw new Error(`Mail transport "${transport}" is not implemented`);
  }

  private async sendWithResend(msg: MailMessage): Promise<void> {
    const key = this.config.get('RESEND_API_KEY');
    if (!key) throw new Error('RESEND_API_KEY is not set');
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.config.get('EMAIL_FROM'), to: [msg.to], subject: msg.subject, text: msg.text, html: toHtml(msg.text) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Resend's error body names the problem (for example an unverified domain); it never contains the key.
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend refused the email (${res.status}): ${detail.slice(0, 300)}`);
    }
    const { id } = (await res.json().catch(() => ({}))) as { id?: string };
    this.logger.log(`Email sent through Resend: id=${id ?? 'unknown'} subject="${msg.subject}"`);
  }
}

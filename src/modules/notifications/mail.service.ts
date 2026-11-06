import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Logged in development only, so links/tokens never reach production logs. */
  devOnlyDetail?: string;
}

/**
 * Outbound email abstraction. The "console" transport is for development.
 * A provider adapter (e.g. SendGrid, Mailgun, Amazon SES, Zoho ZeptoMail)
 * plugs in here once one is chosen — callers do not change.
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
    // No real transport is configured yet; fail loudly rather than silently drop mail.
    throw new Error(`Mail transport "${transport}" is not implemented`);
  }
}

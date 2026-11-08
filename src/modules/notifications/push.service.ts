import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

/** Where a tap on a notification should open in the app, from the record it is about. */
export function pushPath(data: Record<string, unknown> = {}): string {
  if (data.orderId) return '/bookings?tab=orders';
  if (data.reservationId) return '/bookings?tab=stays';
  if (data.spaAppointmentId || data.appointmentId) return '/bookings?tab=spa';
  if (data.serviceBookingId) return '/bookings?tab=services';
  if (data.inquiryId || data.vehicleInquiryId) return '/bookings?tab=cars';
  return '/bookings';
}

/**
 * Sends notifications to customers' phones through Firebase Cloud Messaging (Android and iPhone).
 * On Cloud Run it signs in as the service's own account through the metadata server, so no key is stored.
 * Off when FCM_PROJECT_ID is not set (development and tests). Failures are logged, never thrown.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly projectId: string | undefined;
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfig,
  ) {
    this.projectId = config.get('FCM_PROJECT_ID') || undefined;
  }

  get enabled() {
    return !!this.projectId;
  }

  /** Remembers a phone for a customer. A phone moving to another account is re-assigned. */
  async register(userId: string, token: string, platform: string) {
    await this.prisma.pushDevice.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
    return { ok: true };
  }

  async unregister(userId: string, token: string) {
    await this.prisma.pushDevice.deleteMany({ where: { userId, token } });
    return { ok: true };
  }

  async sendToUser(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    const devices = await this.prisma.pushDevice.findMany({ where: { userId }, select: { token: true } });
    if (!devices.length) return;
    const access = await this.accessToken();
    if (!access) return;
    const path = pushPath(data);
    await Promise.all(devices.map(async ({ token }) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              data: { path },
              android: { priority: 'high', notification: { color: '#0a7a3e' } },
              apns: { payload: { aps: { sound: 'default' } } },
            },
          }),
        });
        if (res.ok) return;
        const text = await res.text();
        // The app was removed or the token is no longer valid: forget this phone.
        if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(text)) {
          await this.prisma.pushDevice.deleteMany({ where: { token } });
        } else {
          this.logger.warn(`Push failed (${res.status}): ${text.slice(0, 200)}`);
        }
      } catch (e) {
        this.logger.warn(`Push failed: ${(e as Error).message}`);
      }
    }));
  }

  /** An access token for the Cloud Run service account, from the metadata server; cached until it nearly expires. */
  private async accessToken(): Promise<string | null> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    try {
      const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/firebase.messaging', {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      if (!res.ok) throw new Error(`metadata ${res.status}`);
      const t = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: t.access_token, expires: Date.now() + t.expires_in * 1000 };
      return t.access_token;
    } catch (e) {
      this.logger.warn(`Push sign-in failed: ${(e as Error).message}`);
      return null;
    }
  }
}

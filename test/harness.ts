/* eslint-disable @typescript-eslint/no-require-imports */
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockPaystack } from './mock-paystack';
import { applyTestEnv, LIVE_PAYSTACK_KEY, MOCK_PAYSTACK_PORT } from './test-env';

applyTestEnv();
const { AppModule } = require('../src/app.module');
const { configureApp } = require('../src/bootstrap');
const { MailService } = require('../src/modules/notifications/mail.service');
const { PrismaService } = require('../src/prisma/prisma.service');

export const API = '/api/v1';

/** Boots the API in-process against the test DB with a mock Paystack. */
export class Harness {
  readonly mails: { to: string; subject: string; devOnlyDetail?: string }[] = [];
  readonly paystack = new MockPaystack();
  app!: INestApplication;
  prisma: any;
  http: any;
  private seq = 0;

  async start() {
    if (!process.env.PAYSTACK_LIVE_TEST_KEY) await this.paystack.start(MOCK_PAYSTACK_PORT);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ send: async (m: any) => void this.mails.push(m) })
      .compile();
    this.app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: ['error'] });
    configureApp(this.app as NestExpressApplication);
    await this.app.init();
    this.prisma = this.app.get(PrismaService);
    this.http = request(this.app.getHttpServer());
  }

  async stop() {
    await this.app?.close();
    if (!process.env.PAYSTACK_LIVE_TEST_KEY) await this.paystack.stop();
  }

  token(to: string, kind: 'verify-email' | 'reset-password'): string {
    const mail = [...this.mails].reverse().find((m) => m.to === to && m.devOnlyDetail?.includes(kind));
    const match = mail?.devOnlyDetail?.match(/token=([\w-]+)/);
    if (!match) throw new Error(`No ${kind} mail for ${to}`);
    return match[1];
  }

  async customer(verified = true) {
    // Real Paystack refuses .test addresses, so its run uses the reserved example.com instead.
    const email = `pm.customer${++this.seq}.${Date.now()}@${LIVE_PAYSTACK_KEY ? 'example.com' : 'example.test'}`;
    const password = 'correct-horse-battery-9';
    const res = await this.http.post(`${API}/auth/register`).send({ email, password, firstName: 'Pay', lastName: `Tester${this.seq}` }).expect(201);
    if (verified) await this.http.post(`${API}/auth/verify-email`).send({ token: this.token(email, 'verify-email') }).expect(200);
    const login = await this.http.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return { email, id: res.body.user.id as string, token: login.body.accessToken as string, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
  }

  async admin() {
    const res = await this.http.post(`${API}/auth/login`).send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }).expect(200);
    return { id: res.body.user.id as string, token: res.body.accessToken as string, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
  }

  /** Creates a staff member with a role (via the admin API) and signs them in. */
  async staff(role: string, division?: string) {
    const admin = await this.admin();
    const email = `pm.staff${++this.seq}.${Date.now()}@nimpat.test`;
    let divisionId: string | undefined;
    if (division) divisionId = (await this.prisma.division.findUniqueOrThrow({ where: { slug: division } })).id;
    const created = await this.http
      .post(`${API}/admin/staff`)
      .set(admin.auth)
      .send({ email, firstName: role, lastName: 'Tester', employeeNumber: `PM-${Date.now()}-${this.seq}`, role, divisionId })
      .expect(201);
    const password = 'staff-pass-12345';
    await this.http.post(`${API}/auth/reset-password`).send({ token: this.token(email, 'reset-password'), newPassword: password }).expect(200);
    const login = await this.http.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return { id: created.body.id as string, email, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
  }

  async address(auth: object) {
    const res = await this.http
      .post(`${API}/me/addresses`)
      .set(auth)
      .send({ recipientName: 'Pay Tester', phone: '+2348031234567', line1: '1 Test Close', city: 'Wuye', state: 'FCT' })
      .expect(201);
    return res.body.id as string;
  }

  /** Gives a variant plenty of stock for this run (test DB fixture). */
  async stock(sku: string, onHand = 500) {
    const v = await this.prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { stockLevels: { include: { location: true } } } });
    const level = v.stockLevels.find((l: any) => l.location.isActive && l.location.isDefault) ?? v.stockLevels[0];
    await this.prisma.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: level.quantityReserved + onHand } });
    return v;
  }

  webhook(payload: unknown) {
    const raw = JSON.stringify(payload);
    const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY as string).update(raw).digest('hex');
    return this.http.post(`${API}/payments/webhooks/paystack`).set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(raw);
  }

  /** Test DB fixture: the seed's DEV_SAMPLE placeholders are treated as confirmed. */
  async markSamplesSellable() {
    for (const m of ['product', 'apartmentUnit', 'vehicle', 'spaTreatment', 'serviceOffering', 'deliveryZone']) {
      await this.prisma[m].updateMany({ where: { verification: { not: 'VERIFIED' } }, data: { verification: 'VERIFIED' } });
    }
  }
}

/**
 * Environment for e2e tests. Uses a SEPARATE database (nimpat_one_test) and a
 * local mock of the Paystack API, so tests never touch dev data or the network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** TEST_DATABASE_URL, or DATABASE_URL from .env pointed at the nimpat_one_test database. */
function testDbUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      url = readFileSync(join(__dirname, '..', '.env'), 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
    } catch {
      /* no .env */
    }
  }
  if (!url) throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL in .env) to run e2e tests');
  const u = new URL(url);
  u.pathname = '/nimpat_one_test';
  return u.toString();
}

export const TEST_DB_URL = testDbUrl();
export const MOCK_PAYSTACK_PORT = 4999;
export const TEST_PAYSTACK_SECRET = 'sk_test_e2e_mock_secret_not_a_real_key';

/** Optional real Paystack TEST key (test/paystack-live.e2e-spec.ts). Live keys are refused. */
export const LIVE_PAYSTACK_KEY = process.env.PAYSTACK_LIVE_TEST_KEY;
export const PAYSTACK_DRY_RUN = process.env.PAYSTACK_DRY_RUN === '1';
if (LIVE_PAYSTACK_KEY && !LIVE_PAYSTACK_KEY.startsWith('sk_test_')) throw new Error('PAYSTACK_LIVE_TEST_KEY must be a TEST key (sk_test_...)');

export function applyTestEnv(): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    JWT_ACCESS_SECRET: 'e2e-test-access-secret-0123456789abcdefghijkl',
    JOBS_TOKEN: 'e2e-test-jobs-token-123456',
    JOBS_INPROCESS: 'false',
    PAYSTACK_SECRET_KEY: LIVE_PAYSTACK_KEY ?? TEST_PAYSTACK_SECRET,
    PAYSTACK_PUBLIC_KEY: 'pk_test_e2e_mock',
    PAYSTACK_BASE_URL: LIVE_PAYSTACK_KEY ? 'https://api.paystack.co' : `http://127.0.0.1:${MOCK_PAYSTACK_PORT}`,
    PAYSTACK_WEBHOOK_IP_ALLOWLIST: '',
    CORS_ORIGINS: 'http://localhost:3000',
    RATE_LIMIT_MAX: '10000',
    AUTH_RATE_LIMIT_MAX: '10000',
    REQUIRE_VERIFIED_EMAIL_FOR_PAYMENT: 'true',
    MAIL_TRANSPORT: 'console',
    SEED_ADMIN_EMAIL: 'e2e.admin@nimpat.test',
    SEED_ADMIN_PASSWORD: 'E2eAdmin!pass-2026',
    SEED_SAMPLE_DATA: 'true',
  });
}

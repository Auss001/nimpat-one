import { validateEnv } from './env.validation';

// Placeholder values only; none of these is a real key.
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JOBS_TOKEN: 'y'.repeat(20),
};
const env = (extra: Record<string, string>) => () => validateEnv({ ...base, ...extra });

describe('Paystack mode', () => {
  it('defaults to test mode and accepts a test key', () => {
    expect(validateEnv({ ...base, PAYSTACK_SECRET_KEY: 'sk_test_abc' }).PAYSTACK_MODE).toBe('test');
  });

  it('refuses a live key in test mode', () => {
    expect(env({ PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow('TEST secret key');
  });

  it('never allows live mode on a development machine', () => {
    expect(env({ PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow('only allowed in production');
  });

  it('in production live mode, needs a live key and refuses a test key', () => {
    const prod = { NODE_ENV: 'production', PAYSTACK_MODE: 'live' };
    expect(validateEnv({ ...base, ...prod, PAYSTACK_SECRET_KEY: 'sk_live_abc' }).PAYSTACK_MODE).toBe('live');
    expect(env({ ...prod, PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toThrow('LIVE secret key');
    expect(env({ ...prod, PAYSTACK_SECRET_KEY: 'sk_live_abc', PAYSTACK_PUBLIC_KEY: 'pk_test_abc' })).toThrow('LIVE public key');
  });

  it('refuses any other mode', () => {
    expect(env({ PAYSTACK_MODE: 'demo', PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toThrow();
  });
});

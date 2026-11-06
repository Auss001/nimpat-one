import { LoyaltyService } from '../../modules/loyalty/loyalty.service';
import { AuthUser, GROUP_SCOPE } from '../../modules/access/auth-user';
import { hashPassword, hmacSha512Hex, safeEqualHex, verifyPassword } from './crypto';
import { nightsBetween, parseDateOnly } from './dates';
import { formatNgn, multiplyMinor, sumMinor } from './money';
import { paymentReference } from './references';

describe('money', () => {
  it('uses exact integer arithmetic in kobo', () => {
    expect(multiplyMinor(250_000n, 3)).toBe(750_000n);
    expect(sumMinor([1n, 2n, 3n])).toBe(6n);
    expect(() => multiplyMinor(100n, 1.5)).toThrow();
    expect(formatNgn(123_456_789n)).toBe('₦1,234,567.89');
    expect(formatNgn(5n)).toBe('₦0.05');
  });
});

describe('loyalty points', () => {
  it('earns per ₦100 at the configured rate, rounding down', () => {
    expect(LoyaltyService.pointsFor(650_000n, 100)).toBe(65); // ₦6,500 @ 1 pt/₦100
    expect(LoyaltyService.pointsFor(650_000n, 150)).toBe(97); // 97.5 → 97
    expect(LoyaltyService.pointsFor(9_999n, 100)).toBe(0); // below ₦100
  });
});

describe('crypto', () => {
  it('hashes and verifies passwords with scrypt', async () => {
    const hash = await hashPassword('a-long-passphrase-1');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a-long-passphrase-1', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('validates Paystack-style HMAC-SHA512 signatures in constant time', () => {
    const sig = hmacSha512Hex('sk_test_x', '{"a":1}');
    expect(safeEqualHex(sig, hmacSha512Hex('sk_test_x', '{"a":1}'))).toBe(true);
    expect(safeEqualHex(sig, hmacSha512Hex('sk_test_x', '{"a":2}'))).toBe(false);
    expect(safeEqualHex(sig, 'zz')).toBe(false);
  });

  it('generates unique, Paystack-safe references', () => {
    const refs = new Set(Array.from({ length: 1000 }, () => paymentReference('WATER_DRINKS_WINES')));
    expect(refs.size).toBe(1000);
    for (const r of refs) expect(r).toMatch(/^NP1-WDW-\d{6}-[0-9A-Z]{10}$/);
  });
});

describe('dates', () => {
  it('parses strict calendar dates and counts nights', () => {
    expect(nightsBetween(parseDateOnly('2026-12-30'), parseDateOnly('2027-01-02'))).toBe(3);
    expect(() => parseDateOnly('2026-02-30')).toThrow();
    expect(() => parseDateOnly('30/12/2026')).toThrow();
  });
});

describe('AuthUser scopes', () => {
  const perms = new Map([
    ['orders:read', new Set(['div-a'])],
    ['reports:read', new Set([GROUP_SCOPE])],
  ]);
  const u = new AuthUser('u', 'e', 'STAFF', true, 's', [], perms);

  it('limits division-scoped permissions to their division', () => {
    expect(u.can('orders:read', 'div-a')).toBe(true);
    expect(u.can('orders:read', 'div-b')).toBe(false);
    expect(u.divisionFilter('orders:read')).toEqual(['div-a']);
    expect(u.can('reports:read', 'div-b')).toBe(true);
    expect(u.divisionFilter('reports:read')).toBeUndefined();
    expect(u.can('catalog:manage', 'div-a')).toBe(false);
  });
});

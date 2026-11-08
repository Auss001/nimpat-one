import { normalizePhone, PHONE_RULE } from './phone';

describe('phone numbers', () => {
  const ok = (raw: string, want: string) => {
    const n = normalizePhone(raw) as string;
    expect(n).toBe(want);
    expect(PHONE_RULE.test(n)).toBe(true);
  };
  it('turns local Nigerian numbers into +234', () => {
    ok('0803 123 4567', '+2348031234567');
    ok('08031234567', '+2348031234567');
    ok('803-123-4567', '+2348031234567');
    ok('2348031234567', '+2348031234567');
    ok('+234 803 123 4567', '+2348031234567');
  });
  it('keeps international numbers', () => {
    ok('+44 7700 900123', '+447700900123');
    ok('0044 7700 900123', '+447700900123');
    ok('+1 (202) 555-0143', '+12025550143');
  });
  it('refuses things that are not phone numbers', () => {
    for (const bad of ['hello', '123', '+234123', '+0123456789', '']) expect(PHONE_RULE.test(normalizePhone(bad) as string)).toBe(false);
  });
});

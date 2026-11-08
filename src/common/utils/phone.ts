import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/**
 * Turns what people type into one international form (E.164), so Nigerian and foreign numbers both work:
 *   0803 123 4567 → +2348031234567   803 123 4567 → +2348031234567   234803… → +234803…
 *   +44 7700 900123 → +447700900123   0044 7700 900123 → +447700900123
 * Anything else is returned unchanged, to be refused by the check below.
 */
export function normalizePhone(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s) return s;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('234') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10 && /^[789]/.test(digits)) return `+234${digits}`;
  return s;
}

/** A full international number: +, a country code, then the number (8 to 15 digits in all). Nigerian ones have 8–10 digits after +234. */
export const PHONE_RULE = /^(?:\+234\d{8,10}|\+(?!234)[1-9]\d{7,14})$/;
export const PHONE_MESSAGE = 'Please enter a valid phone number, for example 0803 123 4567 or +44 7700 900123';

/** Accepts local Nigerian or international numbers and stores them in +country form. */
export function IsPhone() {
  return applyDecorators(Transform(({ value }) => normalizePhone(value)), Matches(PHONE_RULE, { message: PHONE_MESSAGE }));
}

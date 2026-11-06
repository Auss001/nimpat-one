import { BadRequestException } from '@nestjs/common';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a calendar date (YYYY-MM-DD) to a UTC-midnight Date. */
export function parseDateOnly(value: string, field = 'date'): Date {
  if (!ISO_DATE.test(value)) throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return d;
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
}

/** Today's calendar date in the business timezone, as UTC midnight. */
export function todayInZone(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
  return parseDateOnly(parts);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

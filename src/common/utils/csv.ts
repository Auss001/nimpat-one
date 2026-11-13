import { Response } from 'express';

/** One spreadsheet cell: quoted when needed, and never read by Excel as a formula. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString().slice(0, 19).replace('T', ' ') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Sends rows as a .csv download that opens in Excel or Google Sheets (with a byte-order mark for ₦ and accents). */
export function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]): void {
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`﻿${body}\r\n`);
}

/** Naira from kobo, for spreadsheets (a plain number, no symbol). */
export const naira = (minor: bigint | number | null | undefined): string => (minor === null || minor === undefined ? '' : (Number(minor) / 100).toFixed(2));

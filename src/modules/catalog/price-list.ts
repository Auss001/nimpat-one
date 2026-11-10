/**
 * Price list uploads: finding the columns in a supplied spreadsheet and matching
 * each row to a product. Pure functions, so they can be tested without a database.
 */
import { Sheet } from '../../common/utils/spreadsheet';

export interface ListRow {
  sheet: string;
  line: number; // the row number people see in Excel
  code: string;
  name: string;
  salePriceMinor: number | null;
  costPriceMinor: number | null;
  quantity: number | null;
}

export interface Columns {
  code: number;
  name: number;
  sale: number;
  cost: number;
  qty: number;
}

const has = (h: string, re: RegExp) => re.test(h);

/** Finds the header row (within the first ten rows) and the columns that matter. */
export function findColumns(rows: string[][]): { header: number; cols: Columns } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const h = rows[r].map((x) => String(x).toUpperCase().replace(/\s+/g, ' ').trim());
    const pick = (re: RegExp, not?: RegExp) => h.findIndex((x) => has(x, re) && !(not && has(x, not)));
    const cost = pick(/COST/);
    const sale = pick(/SALES?|SELLING|RETAIL|PRICE|AMOUNT|NGN|NAIRA/, /COST/);
    const code = pick(/BARCODE|BAR CODE|BACK CODE|STOCK CODE|ITEM CODE|PRODUCT CODE|\bCODE\b|\bSKU\b/);
    const name = pick(/DESCRIPTION|PRODUCT|ITEM|NAME/, /CODE|SKU|PRICE|COST|QTY|QUANT/);
    const qty = pick(/\bQTY\b|QUANTITY|QUANT|\bSTOCK\b|ON HAND/, /CODE|PRICE|COST/);
    if (name >= 0 && sale >= 0) return { header: r, cols: { code, name, sale, cost, qty } };
  }
  return null;
}

/** "₦2,400", "2400.00" or 2400 → kobo. Anything unreadable, zero or negative is null. */
export function moneyToMinor(value: string): number | null {
  const clean = String(value ?? '').replace(/[₦,\s]|NGN|N(?=\d)/gi, '');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(clean)) return null;
  const minor = Math.round(Number(clean) * 100);
  return minor > 0 ? minor : null;
}

function wholeNumber(value: string): number | null {
  const clean = String(value ?? '').replace(/[,\s]/g, '');
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(clean)) return null;
  return Math.max(0, Math.round(Number(clean)));
}

export function listRows(sheets: Sheet[]): { rows: ListRow[]; skippedSheets: string[] } {
  const rows: ListRow[] = [];
  const skippedSheets: string[] = [];
  for (const s of sheets) {
    const found = findColumns(s.rows);
    if (!found) {
      if (s.rows.length) skippedSheets.push(s.name);
      continue;
    }
    const { header, cols } = found;
    s.rows.slice(header + 1).forEach((r, i) => {
      const name = String(r[cols.name] ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      rows.push({
        sheet: s.name,
        line: header + i + 2,
        code: cols.code >= 0 ? String(r[cols.code] ?? '').trim() : '',
        name,
        salePriceMinor: moneyToMinor(r[cols.sale]),
        costPriceMinor: cols.cost >= 0 ? moneyToMinor(r[cols.cost]) : null,
        quantity: cols.qty >= 0 ? wholeNumber(r[cols.qty]) : null,
      });
    });
  }
  return { rows, skippedSheets };
}

// ---------------------------------------------------------------- names

const SAME: Record<string, string> = {
  TABS: 'TAB', TABLET: 'TAB', TABLETS: 'TAB', DROPS: 'DROP', CAPS: 'CAP', CAPSULE: 'CAP', CAPSULES: 'CAP', CAPLET: 'CAP', CAPLETS: 'CAP',
  SOFTGEL: 'CAP', SOFTGELS: 'CAP', SUSPENSION: 'SUS', SUSP: 'SUS', INJECTION: 'INJ', OINTMENT: 'OINT', SYRUP: 'SYR', SYRP: 'SYR',
  CREAM: 'CRM', GUMMIES: 'GUMMY', LTR: 'L', LITRE: 'L', LITRES: 'L', LITER: 'L', PCS: 'PC', PIECES: 'PC',
};
const NOISE = new Set(['THE', 'OF', 'AND', 'FOR', 'WITH', 'X', 'AS', 'LISTED']);

export function nameWords(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/×/g, ' X ')
    .replace(/([0-9])\s+(MG|ML|MCG|G|KG|IU|L|CL)\b/g, '$1$2')
    .replace(/[^A-Z0-9.]+/g, ' ')
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => SAME[w] ?? w)
    .filter((w) => !NOISE.has(w));
}

/**
 * How alike two names are, from 0 to 1. The first word (usually the brand) must
 * agree, and every number (strength, size, pack) in the shorter name must appear
 * in the other, so "Paracetamol 500mg" never matches "Paracetamol 1000mg".
 */
export function nameScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  if (a[0].slice(0, 4) !== b[0].slice(0, 4)) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const nums = (w: string[]) => w.filter((x) => /[0-9]/.test(x));
  if (nums(short).some((n) => !long.includes(n))) return 0;
  const near = (w: string, list: string[]) => list.some((v) => v === w || (v.length >= 4 && w.length >= 4 && (v.startsWith(w) || w.startsWith(v))));
  const shared = short.filter((w) => near(w, long)).length;
  return shared / long.length;
}

export type MatchHow = 'code' | 'name' | 'close' | 'possible';
export const SURE: MatchHow[] = ['code', 'name', 'close'];

export interface Candidate {
  variantId: string;
  sku: string;
  stockCode: string | null;
  label: string; // product name, plus the size when a product has several
  words: string[];
}

export function matchRow(row: ListRow, candidates: Candidate[], byCode: Map<string, Candidate>): { c: Candidate; how: MatchHow; score: number } | null {
  const code = row.code.toUpperCase();
  if (code && byCode.has(code)) return { c: byCode.get(code)!, how: 'code', score: 1 };
  const words = nameWords(row.name);
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates) {
    const score = nameScore(words, c.words);
    if (score > (best?.score ?? 0)) best = { c, score };
  }
  if (!best) return null;
  if (best.score === 1) return { ...best, how: 'name' };
  if (best.score >= 0.75) return { ...best, how: 'close' };
  if (best.score >= 0.5) return { ...best, how: 'possible' };
  return null;
}

/** A tidy product name from a spreadsheet name: brand in capitals, the rest in lower case. */
export function tidyName(name: string): string {
  const words = name.replace(/\s+/g, ' ').trim().split(' ');
  return words.map((w, i) => (i === 0 ? w.toUpperCase() : w.toLowerCase())).join(' ').replace(/×/g, 'x').slice(0, 160);
}

export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

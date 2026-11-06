/**
 * The API stores money as whole kobo. Staff type naira ("2,500" or
 * "2500.50"); these helpers convert without floating-point rounding.
 */
export function formatNaira(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const naira = Math.floor(abs / 100).toLocaleString('en-NG');
  const kobo = abs % 100;
  return `${negative ? '-' : ''}₦${naira}${kobo ? '.' + String(kobo).padStart(2, '0') : ''}`;
}

/** Naira text for an input box, e.g. 250000 kobo → "2500". */
export function toNairaInput(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  const kobo = minor % 100;
  return `${Math.floor(minor / 100)}${kobo ? '.' + String(kobo).padStart(2, '0') : ''}`;
}

/** Parses "₦2,500.50" → 250050 kobo. Returns null if not a valid amount. */
export function parseNaira(text: string): number | null {
  const clean = text.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

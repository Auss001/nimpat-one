/**
 * Whether customers can see a listing in the app right now, and if not, why — shown beside every item in the
 * dashboard (owner, 14 November 2026: the dashboard must never call something "live" that customers cannot see).
 *
 * `live` always comes from running the customers' own query on the item, so the two cannot disagree; `why` only
 * names the first rule that keeps it hidden, in plain words.
 */
export interface InApp {
  live: boolean;
  why: string | null;
}

export const LIVE: InApp = { live: true, why: null };

/** Marks each row with `inApp`: live when its id is in `shownIds`, otherwise hidden for the first reason found. */
export function markInApp<T extends { id: string }>(rows: T[], shownIds: Set<string>, reason: (row: T) => string | null): (T & { inApp: InApp })[] {
  return rows.map((row) => ({ ...row, inApp: shownIds.has(row.id) ? LIVE : { live: false, why: reason(row) ?? 'Does not meet the app’s rules' } }));
}

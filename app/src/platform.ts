import { Capacitor } from '@capacitor/core';

/**
 * The phone apps launch without the pharmacy and laboratory (owner, 12 November 2026). Apple and Google only accept
 * pharmacy and healthcare apps from a company (organization) developer account, and Nimpat One is on personal ones
 * for now: Google refused the first Android test release for this on 12 November 2026. The website keeps the
 * pharmacy. Bringing it back to the phones means new app versions, published from organization accounts.
 */
export const PHARMACY_SLUG = 'pharmacy-laboratory';
export const HIDE_PHARMACY = Capacitor.isNativePlatform();

/** False for a pharmacy product, link or section when the pharmacy is hidden. */
export const pharmacyAllowed = (divisionSlug?: string | null) => !(HIDE_PHARMACY && divisionSlug === PHARMACY_SLUG);

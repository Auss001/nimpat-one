import { Capacitor } from '@capacitor/core';

/**
 * The iPhone app launches without the pharmacy and laboratory (owner, 12 November 2026). Apple expects pharmacy and
 * healthcare apps to come from a company developer account, and Nimpat One is on a personal one for now. The website
 * and the Android app keep the pharmacy. Bringing it back to iPhone means a new version that Apple reviews, once the
 * app is published from a company (organization) account.
 */
export const PHARMACY_SLUG = 'pharmacy-laboratory';
export const HIDE_PHARMACY = Capacitor.getPlatform() === 'ios';

/** False for a pharmacy product, link or section when the pharmacy is hidden. */
export const pharmacyAllowed = (divisionSlug?: string | null) => !(HIDE_PHARMACY && divisionSlug === PHARMACY_SLUG);

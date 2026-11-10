/**
 * Abuja delivery rings, measured out from Nimpat in Wuye (owner's instruction, 10 November 2026):
 * Wuye and Utako are free, fees rise with distance, and the far edges (Kubwa, Gwarinpa and
 * beyond) are ₦10,000. Staff can change any fee or area afterwards under Delivery zones.
 */
export interface AbujaRing {
  name: string;
  feeMinor: bigint;
  areas: string[];
}

export const ABUJA_RINGS: AbujaRing[] = [
  { name: 'Abuja: Wuye and Utako (free)', feeMinor: 0n, areas: ['Wuye', 'Utako'] },
  {
    name: 'Abuja: central (₦5,000)',
    feeMinor: 500_000n,
    areas: ['Jabi', 'Wuse', 'Wuse 2', 'Berger', 'Mabushi', 'Kado', 'Jahi', 'Garki', 'Garki 2', 'Area 1', 'Area 3', 'Area 7', 'Area 8', 'Area 10', 'Area 11', 'Central Business District', 'Maitama', 'Durumi', 'Gudu', 'Dakibiyan', 'Life Camp'],
  },
  {
    name: 'Abuja: middle ring (₦7,500)',
    feeMinor: 750_000n,
    areas: ['Katampe', 'Katampe Extension', 'Asokoro', 'Guzape', 'Apo', 'Galadimawa', 'Lokogoma', 'Kaura', 'Gaduwa', 'Dawaki', 'Mpape', 'Idu', 'Duboyi', 'Wumba', 'Kabusa'],
  },
  {
    name: 'Abuja: outer ring (₦10,000)',
    feeMinor: 1_000_000n,
    areas: ['Gwarinpa', 'Kubwa', 'Dutse', 'Lugbe', 'Airport Road', 'Karu', 'Nyanya', 'Jikwoyi', 'Karmo', 'Dei-Dei', 'Kurudu', 'Orozo', 'Kuje', 'Bwari', 'Gwagwalada'],
  },
];

/** Areas outside the list fall back to this fee for the whole of Abuja. */
export const ABUJA_FALLBACK_FEE = 1_000_000n;

export const ABUJA_AREAS = ABUJA_RINGS.flatMap((r) => r.areas.map((area) => ({ area, ring: r.name })));

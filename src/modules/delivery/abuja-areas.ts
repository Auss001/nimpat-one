/**
 * Abuja delivery fees from Nimpat in Wuye, as set by the owner on 11 November 2026.
 * Some areas charge more for larger orders: from `bulk.fromQty` items, `bulk.feeMinor`.
 * Staff can change any zone afterwards on the dashboard's Delivery page.
 */
export interface AbujaRing {
  name: string;
  feeMinor: bigint;
  bulk?: { feeMinor: bigint; fromQty: number };
  areas: string[];
}

/** Orders of this many items or more count as larger orders where a zone charges them differently. */
export const LARGER_ORDER_FROM = 10;

export const ABUJA_RINGS: AbujaRing[] = [
  { name: 'Abuja: Wuye and Utako (free)', feeMinor: 0n, areas: ['Wuye', 'Utako'] },
  {
    name: 'Abuja: Jabi, Jahi, Wuse, Garki, Central Area (₦5,000)',
    feeMinor: 500_000n,
    areas: ['Jabi', 'Jahi', 'Mabushi', 'Kado', 'Wuse', 'Wuse 2', 'Berger', 'Garki', 'Garki 2', 'Area 1', 'Area 3', 'Area 7', 'Area 8', 'Area 10', 'Area 11', 'Durumi', 'Dakibiyan', 'Central Area', 'Central Business District', 'Maitama'],
  },
  { name: 'Abuja: Gudu and Apo (₦7,000)', feeMinor: 700_000n, areas: ['Gudu', 'Apo'] },
  {
    name: 'Abuja: Gwarinpa, Asokoro, Guzape (₦7,000, larger orders ₦10,000)',
    feeMinor: 700_000n,
    bulk: { feeMinor: 1_000_000n, fromQty: LARGER_ORDER_FROM },
    areas: ['Gwarinpa', 'Asokoro', 'Guzape', 'Life Camp', 'Katampe', 'Katampe Extension'],
  },
  {
    name: 'Abuja: Lugbe, Games Village, Galadimawa and outer areas (₦10,000)',
    feeMinor: 1_000_000n,
    areas: ['Lugbe', 'Games Village', 'Galadimawa', 'Lokogoma', 'Kaura', 'Gaduwa', 'Dawaki', 'Mpape', 'Idu', 'Duboyi', 'Wumba', 'Kabusa', 'Kubwa', 'Dutse', 'Karu', 'Nyanya', 'Jikwoyi', 'Karmo', 'Dei-Dei', 'Kurudu', 'Orozo', 'Bwari', 'Kuje', 'Gwagwalada'],
  },
  { name: 'Abuja: Airport (₦15,000)', feeMinor: 1_500_000n, areas: ['Airport', 'Airport Road'] },
];

/** Abuja areas not on the list pay this fee. */
export const ABUJA_FALLBACK_FEE = 1_000_000n;

export const ABUJA_AREAS = ABUJA_RINGS.flatMap((r) => r.areas.map((area) => ({ area, ring: r.name })));

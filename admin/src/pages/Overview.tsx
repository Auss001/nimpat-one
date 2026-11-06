import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardCheck, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { get } from '../api';
import { Loading, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface Counts {
  drinks: number;
  retail: number;
  outOfStock: number;
  units: number;
  spa: number;
  therapists: number;
  vehicles: number;
  listings: number;
  toPrepare: number;
  awaitingVerification: number;
  unconfirmed: number;
  sampleZones: boolean;
}

async function loadCounts(): Promise<Counts> {
  // Staff only see the divisions they have access to; anything else counts as empty.
  const page = (p: string) => get(p).catch(() => ({ data: [], meta: { total: 0 } }));
  const list = (p: string) => get<any[]>(p).catch(() => [] as any[]);
  const [drinks, retail, stockW, stockR, props, spa, therapists, vehicles, services, accepted, zones, awaiting, audit] = await Promise.all([
    page('/admin/catalog/products?division=water-drinks-wines&status=ACTIVE&pageSize=1'),
    page('/admin/catalog/products?division=retail-general-supplies&status=ACTIVE&pageSize=1'),
    page('/admin/inventory?division=water-drinks-wines&pageSize=100'),
    page('/admin/inventory?division=retail-general-supplies&pageSize=100'),
    list('/admin/apartments/properties'),
    list('/admin/spa/treatments'),
    list('/admin/spa/practitioners'),
    page('/admin/vehicles?pageSize=100'),
    list('/admin/services'),
    page('/admin/orders?status=ACCEPTED&pageSize=1'),
    list('/admin/delivery/zones?division=water-drinks-wines'),
    page('/admin/payments?status=AWAITING_VERIFICATION&pageSize=1'),
    get('/admin/records/audit').catch(() => ({ verificationCounts: {} })),
  ]);
  const unconfirmed = Object.values<any>(audit.verificationCounts).reduce((n, c) => n + (c.AWAITING_CONFIRMATION ?? 0), 0);
  return {
    drinks: drinks.meta.total,
    retail: retail.meta.total,
    outOfStock: [...stockW.data, ...stockR.data].filter((l: any) => l.available <= 0).length,
    units: props.flatMap((p) => p.units).filter((u: any) => u.status === 'ACTIVE' && u.verification !== 'DEV_SAMPLE').length,
    spa: spa.filter((t) => t.isActive && t.verification !== 'DEV_SAMPLE').length,
    therapists: therapists.filter((t) => t.isActive && !t.displayName.startsWith('[DEV SAMPLE]')).length,
    vehicles: vehicles.data.filter((v: any) => (v.status === 'AVAILABLE' || v.status === 'RESERVED') && v.verification !== 'DEV_SAMPLE').length,
    listings: services.filter((s) => s.isActive && s.verification !== 'DEV_SAMPLE').length,
    toPrepare: accepted.meta.total,
    awaitingVerification: awaiting.meta.total,
    unconfirmed,
    sampleZones: zones.some((z) => z.isActive && z.verification === 'DEV_SAMPLE'),
  };
}

const TILES = (c: Counts): { to: string; label: string; sub: string; img: string; corner?: string }[] => [
  { to: '/drinks', label: 'Water, Drinks & Wines', sub: `${c.drinks} products`, img: '/media/assets/drinks-stock-4.jpg' },
  { to: '/apartments', label: 'Luxury Apartments', sub: `${c.units} units`, img: '/media/images/mabushi/flat-1/living-room-tv.jpg' },
  { to: '/spa', label: 'Spa & Wellness', sub: `${c.spa} treatments`, img: '/media/assets/spa-wellness.jpg', corner: c.therapists ? undefined : 'No therapists' },
  { to: '/vehicles', label: 'Automobiles', sub: `${c.vehicles} vehicles`, img: '/media/assets/car-stand-0.jpg' },
  { to: '/services', label: 'Rentals & property', sub: `${c.listings} listings`, img: '/media/assets/media-events-stage.jpg' },
  { to: '/retail', label: 'Retail & Supplies', sub: `${c.retail} products`, img: '/media/assets/interior-decoration.jpg' },
];

export function OverviewPage() {
  const counts = useLoad(loadCounts);
  const summary = useLoad(() => get<any>('/admin/reports/summary'));
  const c = counts.data;

  // The most urgent job leads the page.
  const lead = !c ? null
    : c.awaitingVerification ? { tag: 'Finance', title: 'Payments to verify', text: `${c.awaitingVerification} payment${c.awaitingVerification > 1 ? 's are' : ' is'} waiting for finance to check against bank or cash records.`, to: '/payments', cta: 'Review payments' }
    : c.unconfirmed ? { tag: 'Before you sell', title: 'Confirm your catalogue', text: `${c.unconfirmed} records are waiting for company confirmation. Customers can only buy or book confirmed items.`, to: '/data-check', cta: 'Start confirming' }
    : c.outOfStock ? { tag: 'Stock', title: 'Add opening stock', text: `${c.outOfStock} products have no stock, so they cannot be ordered yet.`, to: '/stock', cta: 'Update stock' }
    : { tag: 'All clear', title: 'Nimpat One is ready', text: 'No urgent jobs right now.', to: '/orders', cta: 'See orders' };

  return (
    <>
      <Loading error={counts.error} loading={counts.loading && !c} />
      {c && lead && (
        <>
          <div className="hero-grid">
            <section className="hero">
              <img src="/media/images/mabushi/flat-2/wine-display-lounge.jpg" alt="" />
              <span className="tag">{lead.tag}</span>
              <h1 className="display">{lead.title}</h1>
              <p>{lead.text}</p>
              <Link className="btn primary" to={lead.to}>{lead.cta} <ArrowRight size={16} /></Link>
            </section>
            <div className="side-stack">
              <Link to="/stock" className="promo peach">
                <img src="/media/assets/drinks-stock-1.jpg" alt="" />
                <h3><span className="accent">{c.outOfStock}</span> out of stock</h3>
                <p>Receive deliveries and set counts</p>
                <span className="more-link">Open stock <ArrowRight size={14} /></span>
              </Link>
              <Link to="/orders" className="promo lavender">
                <img src="/media/assets/car-stand-1.jpg" alt="" />
                <span className="tag violet">Orders</span>
                <h3>{c.toPrepare} to prepare</h3>
                <span className="more-link">Open orders <ArrowRight size={14} /></span>
              </Link>
            </div>
          </div>

          <div className="section-head">
            <h2>Explore your divisions</h2>
            <Link to="/data-check">Data confirmation <ArrowRight size={15} /></Link>
          </div>
          <div className="tiles">
            {TILES(c).map((t, i) => (
              <Link key={t.to} to={t.to} className={`tile tone-${i % 4}`}>
                {t.corner && <span className="corner">{t.corner}</span>}
                <img src={t.img} alt="" loading="lazy" />
                <strong>{t.label}</strong>
                <span className="sub">{t.sub}</span>
              </Link>
            ))}
          </div>

          <div className="strip">
            <Link to="/payments"><span className="circle"><Wallet size={19} /></span><div><strong>{formatNaira(summary.data?.grossRevenueMinor ?? 0)}</strong><span>Verified, last 30 days</span></div></Link>
            <Link to="/payments"><span className="circle c1"><ShieldCheck size={19} /></span><div><strong>{c.awaitingVerification} awaiting</strong><span>Finance verification</span></div></Link>
            <Link to="/data-check"><span className="circle c2"><ClipboardCheck size={19} /></span><div><strong>{c.unconfirmed} unconfirmed</strong><span>Catalogue records</span></div></Link>
            <Link to="/delivery"><span className="circle"><Truck size={19} /></span><div><strong>{c.sampleZones ? 'Sample zones' : 'Zones set'}</strong><span>Delivery areas and fees</span></div></Link>
          </div>
        </>
      )}
    </>
  );
}

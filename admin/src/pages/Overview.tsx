import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardCheck, Pill, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { useAccess } from '../access';
import { get } from '../api';
import { Donut, type Slice } from '../components/Donut';
import { Loading, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface Counts {
  drinks: number;
  retail: number;
  pharmacy: number;
  units: number;
  readyUnits: number;
  spa: number;
  therapists: number;
  vehicles: number;
  listings: number;
  toPrepare: number;
  awaitingVerification: number;
  unconfirmed: number;
  zones: number;
}

async function loadCounts(): Promise<Counts> {
  // Staff only see the divisions they have access to; anything else counts as empty.
  const page = (p: string) => get(p).catch(() => ({ data: [], meta: { total: 0 } }));
  const list = (p: string) => get<any[]>(p).catch(() => [] as any[]);
  const [drinks, retail, pharmacy, props, spa, therapists, vehicles, services, accepted, zones, awaiting, audit] = await Promise.all([
    page('/admin/catalog/products?division=water-drinks-wines&status=ACTIVE&pageSize=1'),
    page('/admin/catalog/products?division=retail-general-supplies&status=ACTIVE&pageSize=1'),
    page('/admin/catalog/products?division=pharmacy-laboratory&status=ACTIVE&pageSize=1'),
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
  const units = props.filter((p) => p.status === 'ACTIVE').flatMap((p) => p.units).filter((u: any) => u.status === 'ACTIVE' && u.verification !== 'DEV_SAMPLE');
  return {
    drinks: drinks.meta.total,
    retail: retail.meta.total,
    pharmacy: pharmacy.meta.total,
    units: units.length,
    readyUnits: units.filter((u: any) => u.readiness === 'READY').length,
    spa: spa.filter((t) => t.isActive && t.verification !== 'DEV_SAMPLE').length,
    therapists: therapists.filter((t) => t.isActive && !t.displayName.startsWith('[DEV SAMPLE]')).length,
    vehicles: vehicles.data.filter((v: any) => (v.status === 'AVAILABLE' || v.status === 'RESERVED') && v.verification !== 'DEV_SAMPLE').length,
    listings: services.filter((s) => s.isActive && s.verification !== 'DEV_SAMPLE').length,
    toPrepare: accepted.meta.total,
    awaitingVerification: awaiting.meta.total,
    unconfirmed,
    zones: zones.filter((z) => z.isActive).length,
  };
}

// Fixed categorical order, checked for colour-blind separation on the white card surface.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const OTHER = '#898781';
/** Six colours at most; anything further is folded into Other rather than given a new colour. */
const series = (rows: { label: string; count: number }[]): Slice[] => {
  const head = rows.length > SERIES.length ? rows.slice(0, SERIES.length - 1) : rows;
  const rest = rows.slice(head.length).reduce((n, r) => n + r.count, 0);
  const slices = head.map((r, i) => ({ label: r.label, value: r.count, color: SERIES[i] }));
  return rest ? [...slices, { label: 'Other', value: rest, color: OTHER }] : slices;
};
const CONDITION: Record<string, { label: string; color: string }> = {
  READY: { label: 'Ready to sell', color: '#0ca30c' },
  FINISHING: { label: 'Finishing touches', color: '#fab219' },
  SERVICING: { label: 'Being serviced', color: '#898781' },
  MAINTENANCE: { label: 'Under maintenance', color: '#ec835a' },
  NOT_READY: { label: 'Not ready', color: '#d03b3b' },
};

interface Progress {
  done: number;
  total: number;
}
interface Report {
  scope: 'group' | 'divisions';
  holdings: { label: string; count: number }[];
  apartments: { total: number; ready: number; byLocation: { label: string; count: number }[]; byCondition: { code: string; count: number }[] };
  stock: { total: number; inStock: number; low: number; out: number; uncounted: number };
  records: { confirmed: number; total: number };
  revenue: { totalMinor: number; byDivision: { label: string; minor: number }[] };
  launch: { prices: Progress; photos: Progress; stock: Progress; payments: { bankAccounts: number; serviceLocations: number } };
}

function AtAGlance({ r }: { r: Report }) {
  const holdings = r.holdings.reduce((n, h) => n + h.count, 0);
  const confirmedPct = r.records.total ? Math.round((r.records.confirmed / r.records.total) * 100) : 0;
  // A manager of one division gets nothing from empty charts or a ring with a single slice.
  const group = r.scope === 'group';
  const hasApartments = group || r.apartments.total > 0;
  return (
    <>
      <div className="section-head">
        <h2>{group ? 'Everything Nimpat has' : 'Your divisions at a glance'}</h2>
        <span className="muted small">Switched-off items are left out</span>
      </div>
      <div className="kpis">
        <div className="card kpi"><span>Items on record</span><strong>{holdings}</strong></div>
        {hasApartments && <Link to="/apartments" className="card kpi"><span>Apartments ready to sell</span><strong>{r.apartments.ready} <small>of {r.apartments.total}</small></strong></Link>}
        <Link to="/data-check" className="card kpi">
          <span>Records confirmed</span><strong>{r.records.confirmed} <small>of {r.records.total}</small></strong>
          <div className="meter" role="img" aria-label={`${confirmedPct}% of records confirmed`}><div style={{ width: `${confirmedPct}%` }} /></div>
        </Link>
        <Link to="/payments" className="card kpi"><span>Verified revenue, last 30 days</span><strong>{formatNaira(r.revenue.totalMinor)}</strong></Link>
      </div>
      <div className="charts">
        {(group || r.holdings.length > 1) && <Donut title={group ? 'What Nimpat has' : 'What you manage'} unit="items" slices={series(r.holdings)} empty="Nothing on record yet." />}
        {hasApartments && (group || r.apartments.byLocation.length > 1) && <Donut title="Apartments by location" unit="units" slices={series(r.apartments.byLocation)} empty="No apartments on record yet." />}
        {hasApartments && <Donut title="Apartment condition" unit="units" slices={r.apartments.byCondition.map((c) => ({ label: CONDITION[c.code]?.label ?? c.code, value: c.count, color: CONDITION[c.code]?.color ?? '#898781' }))} empty="No apartments on record yet." />}
        {r.stock.total > 0 && <Donut
          title="Stock health"
          unit="items"
          slices={[
            { label: 'In stock', value: r.stock.inStock, color: '#0ca30c' },
            { label: 'Running low', value: r.stock.low, color: '#fab219' },
            { label: 'Out of stock', value: r.stock.out, color: '#d03b3b' },
            { label: 'Not counted yet', value: r.stock.uncounted, color: '#898781' },
          ]}
          empty="No stock lines yet."
        />}
        {(group || r.revenue.byDivision.length > 1) && <Donut
          title="Verified revenue by division"
          unit="total"
          format={formatNaira}
          slices={r.revenue.byDivision.slice(0, SERIES.length).map((d, i) => ({ label: d.label, value: d.minor, color: SERIES[i] }))}
          empty="No verified payments in the last 30 days."
        />}
      </div>
    </>
  );
}

const TILES = (c: Counts): { to: string; label: string; sub: string; img?: string; corner?: string }[] => [
  { to: '/drinks', label: 'Water, Drinks & Wines', sub: `${c.drinks} products`, img: '/media/assets/drinks-stock-4.jpg' },
  { to: '/pharmacy', label: 'Pharmacy & Laboratory', sub: `${c.pharmacy} products`, img: '/pharmacy-lab.webp', corner: 'Awaiting pharmacist' },
  { to: '/apartments', label: 'Luxury Apartments', sub: `${c.units} units`, img: '/media/images/mabushi/flat-1/living-room-tv.jpg' },
  { to: '/spa', label: 'Spa & Wellness', sub: `${c.spa} treatments`, img: '/media/assets/spa-wellness.jpg', corner: c.therapists ? undefined : 'No therapists' },
  { to: '/vehicles', label: 'Automobiles', sub: `${c.vehicles} vehicles`, img: '/media/assets/car-stand-0.jpg' },
  { to: '/services', label: 'Rentals & property', sub: `${c.listings} listings`, img: '/media/assets/media-events-stage.jpg' },
  { to: '/retail', label: 'Retail & Supplies', sub: `${c.retail} products`, img: '/media/assets/interior-decoration.jpg' },
];

const LISTING_DIVISIONS = ['automobiles', 'transport-logistics', 'retail-general-supplies', 'media-events-rentals', 'real-estate-interior-design', 'entertainment', 'pharmacy-laboratory'];
const TILE_ACCESS: Record<string, { any: string[]; division?: string | string[] }> = {
  '/drinks': { any: ['catalog:manage'], division: 'water-drinks-wines' },
  '/pharmacy': { any: ['catalog:manage'], division: 'pharmacy-laboratory' },
  '/apartments': { any: ['listings:manage'], division: 'luxury-apartments' },
  '/spa': { any: ['listings:manage'], division: 'spa-wellness' },
  '/vehicles': { any: ['listings:manage'], division: 'automobiles' },
  '/services': { any: ['listings:manage'], division: LISTING_DIVISIONS },
  '/retail': { any: ['catalog:manage'], division: 'retail-general-supplies' },
};

const pct = (p: Progress) => (p.total ? Math.floor((p.done / p.total) * 100) : 0);

/** A progress ring for one launch step. */
function Ring({ value }: { value: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="4" />
        {value > 0 && <circle cx="24" cy="24" r={r} fill="none" stroke={value >= 100 ? '#3fd07a' : '#ff8a3d'} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} />}
      </svg>
      <span>{value}%</span>
    </span>
  );
}

function Runway({ r }: { r: Report }) {
  const paid = (r.launch.payments.bankAccounts ? 1 : 0) + (r.launch.payments.serviceLocations ? 1 : 0);
  const steps: { to: string; label: string; progress: Progress; note: string }[] = [
    { to: '/data-check', label: 'Confirm', progress: { done: r.records.confirmed, total: r.records.total }, note: `${r.records.confirmed} of ${r.records.total}` },
    { to: '/stock', label: 'Count stock', progress: r.launch.stock, note: `${r.launch.stock.done} of ${r.launch.stock.total}` },
    { to: '/drinks', label: 'Set prices', progress: r.launch.prices, note: `${r.launch.prices.done} of ${r.launch.prices.total}` },
    { to: '/drinks', label: 'Add photos', progress: r.launch.photos, note: `${r.launch.photos.done} of ${r.launch.photos.total}` },
    { to: '/payment-settings', label: 'Payments', progress: { done: paid, total: 2 }, note: `${paid} of 2 set up` },
  ];
  const next = steps.findIndex((s) => pct(s.progress) < 100);
  return (
    <ol className="runway" aria-label="Steps before launch">
      {steps.map((s, i) => (
        <li key={s.label} className={i === next ? 'now' : ''}>
          <Link to={s.to} aria-current={i === next ? 'step' : undefined}>
            <Ring value={pct(s.progress)} />
            <b>{s.label}</b>
            <small>{s.note}</small>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** A photo tile that slowly moves through its pictures. Still when the viewer prefers less motion. */
function WallTile({ to, images, big, label, tall, delay }: { to: string; images: string[]; big: string; label: string; tall?: boolean; delay: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (images.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      timer = setInterval(() => setIndex((i) => (i + 1) % images.length), 6500);
    }, delay);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [images.length, delay]);
  return (
    <Link to={to} className={`wall-tile ${tall ? 'tall' : ''}`}>
      {images.map((src, i) => <img key={src} src={src} alt="" className={i === index ? 'on' : ''} />)}
      <strong>{big}</strong>
      <span>{label}</span>
    </Link>
  );
}

const hello = () => {
  const h = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export function OverviewPage() {
  const counts = useLoad(loadCounts);
  const report = useLoad(() => get<Report>('/admin/reports/overview').catch(() => null));
  const { can } = useAccess();
  const c = counts.data;
  const r = report.data;

  // The most urgent job leads the page.
  const lead = !c ? null
    : c.awaitingVerification ? { title: 'Payments to verify', text: `${c.awaitingVerification} payment${c.awaitingVerification > 1 ? 's are' : ' is'} waiting for finance to check against bank or cash records.`, to: '/payments', cta: 'Review payments' }
    : c.unconfirmed ? { title: 'Confirm your catalogue', text: `${c.unconfirmed} records are waiting for company confirmation. Customers can only buy or book confirmed items.`, to: '/data-check', cta: 'Start confirming' }
    : (r?.stock.out ?? 0) > 0 ? { title: 'Add opening stock', text: `${r?.stock.out} items have no stock, so they cannot be ordered yet.`, to: '/stock', cta: 'Update stock' }
    : { title: 'Nimpat One is ready', text: 'No urgent jobs right now.', to: '/orders', cta: 'See orders' };

  return (
    <>
      <Loading error={counts.error} loading={counts.loading && !c} />
      {c && lead && (
        <>
          <div className="launch">
            <section className="launch-panel">
              <div className="launch-kicker">
                <span><strong>{hello()}.</strong> {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' })}</span>
                {r && <span>Road to launch</span>}
              </div>
              <h1>{lead.title}</h1>
              <p>{lead.text}</p>
              <Link className="btn primary" to={lead.to}>{lead.cta} <ArrowRight size={16} /></Link>
              {r && <Runway r={r} />}
            </section>
            <div className="wall">
              {can(TILE_ACCESS['/apartments']) && (
                <WallTile
                  tall
                  to="/apartments"
                  delay={0}
                  big={`${c.readyUnits} of ${c.units}`}
                  label="apartments ready to sell"
                  images={['/media/images/mabushi/flat-2/wine-display-lounge.jpg', '/media/images/mabushi/flat-1/living-room-tv.jpg', '/media/images/mabushi/flat-3/dining-room.jpg', '/media/images/mabushi/flat-4/lounge-seating.jpg']}
                />
              )}
              {can(TILE_ACCESS['/vehicles']) && <WallTile to="/vehicles" delay={1800} big={String(c.vehicles)} label="cars available" images={['/media/assets/car-stand-0.jpg', '/media/assets/car-stand-1.jpg', '/media/assets/car-stand-2.jpg']} />}
              {can(TILE_ACCESS['/drinks']) && <WallTile to="/drinks" delay={3400} big={String(c.drinks)} label="water and drinks" images={['/media/assets/drinks-stock-1.jpg', '/media/assets/drinks-stock-4.jpg', '/media/assets/drinks-stock-7.jpg']} />}
              {can(TILE_ACCESS['/pharmacy']) && <WallTile to="/pharmacy" delay={4200} big={String(c.pharmacy)} label="pharmacy products, awaiting pharmacist" images={['/pharmacy-lab.webp']} />}
              {can(TILE_ACCESS['/spa']) && <WallTile to="/spa" delay={5000} big={String(c.spa)} label={c.therapists ? 'spa treatments' : 'spa treatments, no therapists yet'} images={['/media/assets/spa-wellness.jpg', '/media/assets/royalty-spa-clean.webp']} />}
            </div>
          </div>

          {r && <AtAGlance r={r} />}

          <div className="section-head">
            <h2>Explore your divisions</h2>
            <Link to="/data-check">Data confirmation <ArrowRight size={15} /></Link>
          </div>
          <div className="tiles">
            {TILES(c).filter((t) => can(TILE_ACCESS[t.to])).map((t, i) => (
              <Link key={t.to} to={t.to} className={`tile tone-${i % 4}`}>
                {t.corner && <span className="corner">{t.corner}</span>}
                {t.img ? <img src={t.img} alt="" loading="lazy" /> : <div className="tile-icon"><Pill size={46} aria-hidden="true" /></div>}
                <strong>{t.label}</strong>
                <span className="sub">{t.sub}</span>
              </Link>
            ))}
          </div>

          <div className="strip">
            <Link to="/orders"><span className="circle"><Wallet size={19} /></span><div><strong>{c.toPrepare} to prepare</strong><span>Orders</span></div></Link>
            <Link to="/payments"><span className="circle c1"><ShieldCheck size={19} /></span><div><strong>{c.awaitingVerification} awaiting</strong><span>Finance verification</span></div></Link>
            <Link to="/data-check"><span className="circle c2"><ClipboardCheck size={19} /></span><div><strong>{c.unconfirmed} unconfirmed</strong><span>Catalogue records</span></div></Link>
            <Link to="/delivery"><span className="circle"><Truck size={19} /></span><div><strong>{c.zones ? `${c.zones} zones set` : 'No zones yet'}</strong><span>Delivery areas and fees</span></div></Link>
          </div>
        </>
      )}
    </>
  );
}

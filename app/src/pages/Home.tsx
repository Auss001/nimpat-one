import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Car, Clapperboard, Droplets, FlaskConical, HousePlus, Package, Pill, Search, Sparkles, Ticket, Truck, type LucideIcon } from 'lucide-react';
import { formatNaira, get, rows } from '../api';
import { loadStays, StayCard } from './Apartments';
import { ProductCard } from './Shop';
import { FavButton, Photo, Rail, Skeletons, useLoad, viewedProducts } from '../ui';
import { HomeSlider } from './HomeSlider';
import { LegalLinks } from './Legal';

export const WORLDS: { to: string; label: string; icon: LucideIcon; tone: string }[] = [
  { to: '/shop/water-drinks-wines', label: 'Drinks', icon: Droplets, tone: 'blue' },
  { to: '/pharmacy', label: 'Pharmacy', icon: Pill, tone: 'green' },
  { to: '/apartments', label: 'Luxury Apartments', icon: Building2, tone: 'orange' },
  { to: '/spa', label: 'Spa', icon: Sparkles, tone: 'pink' },
  { to: '/cars', label: 'Cars', icon: Car, tone: 'red' },
  { to: '/services/pharmacy-laboratory', label: 'Lab', icon: FlaskConical, tone: 'teal' },
  { to: '/services/transport-logistics', label: 'Logistics', icon: Truck, tone: 'blue' },
  { to: '/shop/retail-general-supplies', label: 'Supplies', icon: Package, tone: 'yellow' },
  { to: '/services/media-events-rentals', label: 'Rentals', icon: Clapperboard, tone: 'violet' },
  { to: '/services/real-estate-interior-design', label: 'Property', icon: HousePlus, tone: 'brown' },
  { to: '/services/entertainment', label: 'Fun', icon: Ticket, tone: 'magenta' },
];

const SHORT_NAME: Record<string, string> = {
  water: 'Water',
  'soft-drinks-juices-energy-drinks': 'Soft drinks',
  'wines-sparkling-ports': 'Wines',
  champagnes: 'Champagne',
  'spirits-whiskies-cognacs-tequilas': 'Spirits',
};

export function HomePage() {
  const home = useLoad(async () => {
    const none = { data: [] as any[] };
    const [drinks, pharmacy, supplies, stays, cars, spa] = await Promise.all([
      get('/catalog/products?division=water-drinks-wines&pageSize=100').catch(() => none),
      get('/catalog/products?division=pharmacy-laboratory&pageSize=12').catch(() => none),
      get('/catalog/products?division=retail-general-supplies&pageSize=12').catch(() => none),
      loadStays().catch(() => [] as any[]),
      get('/vehicles?pageSize=10').catch(() => none),
      get('/spa/treatments?pageSize=10').catch(() => none),
    ]);
    return { drinks: rows(drinks), pharmacy: rows(pharmacy), supplies: rows(supplies), stays, cars: rows(cars), spa: rows(spa).slice(0, 10) };
  });
  const d = home.data;
  const empty = d && !d.drinks.length && !d.pharmacy.length && !d.stays.length && !d.cars.length && !d.spa.length;
  const viewed = useMemo(() => viewedProducts(), []);

  const shelves = useMemo(() => {
    const drinks = (d?.drinks ?? []).filter((p: any) => p.images?.length && p.priceFromMinor != null);
    const byPrice = [...drinks].sort((a: any, b: any) => (b.priceFromMinor ?? 0) - (a.priceFromMinor ?? 0));
    const categories = new Map<string, { slug: string; name: string; items: any[] }>();
    for (const p of drinks) {
      const slug = p.category?.slug;
      if (!slug) continue;
      if (!categories.has(slug)) categories.set(slug, { slug, name: SHORT_NAME[slug] ?? p.category.name, items: [] });
      categories.get(slug)!.items.push(p);
    }
    return { topShelf: byPrice.slice(0, 12), categories: [...categories.values()] };
  }, [d]);

  return (
    <div className="home">
      <Link to="/search" className="search-entry"><Search size={18} aria-hidden="true" /> What do you need?</Link>

      <nav className="worlds" aria-label="Everything on Nimpat One">
        {WORLDS.map(({ to, label, icon: Icon, tone }) => (
          <Link key={to} to={to} className="world">
            <span className={`bubble ${tone}`}><Icon size={24} aria-hidden="true" /></span>
            {label}
          </Link>
        ))}
      </nav>

      <HomeSlider stays={d?.stays ?? []} />

      {home.loading && !d && <Skeletons />}
      {empty && <div className="getting-ready"><h2>Coming soon</h2></div>}

      {viewed.length > 0 && (
        <Rail title="Recently viewed" to="/search">
          {viewed.map((p) => (
            <Link key={p.slug} to={`/product/${p.slug}`} className="card">
              <div className="card-photo square"><Photo src={p.image} alt={p.name} fit="contain" /></div>
              <div className="card-body"><strong>{p.name}</strong></div>
            </Link>
          ))}
        </Rail>
      )}

      {shelves.topShelf.length > 0 && <Rail title="Top shelf" to="/shop/water-drinks-wines">{shelves.topShelf.map((p: any) => <ProductCard key={p.id} product={p} />)}</Rail>}

      {d && d.stays.length > 0 && <Rail title="Luxury Apartments" to="/apartments">{d.stays.map((s: any) => <StayCard key={s.key} stay={s} wide />)}</Rail>}

      {shelves.categories.map((c) => c.items.length > 1 && (
        <Rail key={c.slug} title={c.name} to={`/shop/water-drinks-wines?category=${c.slug}`}>
          {c.items.slice(0, 12).map((p: any) => <ProductCard key={p.id} product={p} />)}
        </Rail>
      ))}

      {d && d.supplies.length > 0 && <Rail title="Supplies" to="/shop/retail-general-supplies">{d.supplies.map((p: any) => <ProductCard key={p.id} product={p} />)}</Rail>}

      {d && d.pharmacy.length > 0 && <Rail title="Pharmacy" to="/pharmacy">{d.pharmacy.map((p: any) => <ProductCard key={p.id} product={p} />)}</Rail>}

      {d && d.cars.length > 0 && (
        <Rail title="Cars" to="/cars">
          {d.cars.map((v: any) => (
            <Link key={v.id} to={`/cars/${v.slug}`} className="card wide">
              <FavButton kind="VEHICLE" slug={v.slug} />
              <div className="card-photo"><Photo src={v.images?.[0]?.url} alt={`${v.year} ${v.make} ${v.model}`} /></div>
              <div className="card-body">
                <strong>{v.year} {v.make} {v.model}</strong>
                <span className="price">{v.priceMinor !== null ? formatNaira(v.priceMinor) : 'Contact for price'}</span>
              </div>
            </Link>
          ))}
        </Rail>
      )}

      {d && d.spa.length > 0 && (
        <Rail title="Spa" to="/spa">
          {d.spa.map((t: any) => (
            <Link key={t.id} to={`/spa/${t.slug}`} className="card wide">
              <FavButton kind="TREATMENT" slug={t.slug} />
              <div className="card-photo"><Photo src={t.imageUrl} alt={t.name} /></div>
              <div className="card-body">
                <strong>{t.name}</strong>
                <small>{t.durationMinutes} minutes</small>
                <span className="price">{formatNaira(t.priceMinor)}</span>
              </div>
            </Link>
          ))}
        </Rail>
      )}
      <LegalLinks />
    </div>
  );
}

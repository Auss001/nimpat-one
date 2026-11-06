import { Link } from 'react-router-dom';
import { Building2, Car, Clapperboard, Droplets, FlaskConical, HousePlus, Package, Pill, Sparkles, Ticket, type LucideIcon } from 'lucide-react';
import { formatNaira, get, rows } from '../api';
import { ProductCard } from './Shop';
import { Photo, Rail, useLoad, useSession } from '../ui';

export function Wordmark() {
  return <span className="wordmark">nimpat<span>one</span></span>;
}

// The colours come from the arcs of the Nimpat logo.
export const WORLDS: { to: string; label: string; icon: LucideIcon; tone: string }[] = [
  { to: '/shop/water-drinks-wines', label: 'Water & Drinks', icon: Droplets, tone: 'blue' },
  { to: '/pharmacy', label: 'Pharmacy', icon: Pill, tone: 'green' },
  { to: '/services/pharmacy-laboratory', label: 'Laboratory', icon: FlaskConical, tone: 'teal' },
  { to: '/apartments', label: 'Apartments', icon: Building2, tone: 'orange' },
  { to: '/spa', label: 'Spa', icon: Sparkles, tone: 'pink' },
  { to: '/cars', label: 'Cars', icon: Car, tone: 'red' },
  { to: '/shop/retail-general-supplies', label: 'Supplies', icon: Package, tone: 'yellow' },
  { to: '/services/media-events-rentals', label: 'Rentals', icon: Clapperboard, tone: 'violet' },
  { to: '/services/real-estate-interior-design', label: 'Property', icon: HousePlus, tone: 'brown' },
  { to: '/services/entertainment', label: 'Entertainment', icon: Ticket, tone: 'magenta' },
];

export function HomePage() {
  const session = useSession();
  const home = useLoad(async () => {
    const none = { data: [] as any[] };
    const [drinks, pharmacy, stays, cars, spa] = await Promise.all([
      get('/catalog/products?division=water-drinks-wines&pageSize=12').catch(() => none),
      get('/catalog/products?division=pharmacy-laboratory&pageSize=12').catch(() => none),
      get('/apartments/properties?pageSize=10').catch(() => none),
      get('/vehicles?pageSize=10').catch(() => none),
      get('/spa/treatments?pageSize=10').catch(() => none),
    ]);
    return { drinks: rows(drinks), pharmacy: rows(pharmacy), stays: rows(stays), cars: rows(cars), spa: rows(spa).slice(0, 10) };
  });
  const d = home.data;
  const empty = d && !d.drinks.length && !d.pharmacy.length && !d.stays.length && !d.cars.length && !d.spa.length;

  return (
    <div className="home">
      <section className="hero-one">
        <div className="hero-arcs" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <p className="kicker">{session?.firstName ? `Welcome back, ${session.firstName}` : 'A little more life. A lot more possibility.'}</p>
        <h1>Your everyday.<br />Beautifully connected.</h1>
        <p className="lede">Shop your essentials. Find your next stay. Book a little time for you.</p>
      </section>

      <nav className="worlds" aria-label="Everything on Nimpat One">
        {WORLDS.map(({ to, label, icon: Icon, tone }) => (
          <Link key={to} to={to} className="world">
            <span className={`bubble ${tone}`}><Icon size={26} aria-hidden="true" /></span>
            {label}
          </Link>
        ))}
      </nav>

      {empty && (
        <div className="getting-ready">
          <h2>We are stocking the shelves</h2>
          <p>Our team is confirming products, prices and availability. They will appear here as soon as each is ready.</p>
        </div>
      )}

      {d && d.drinks.length > 0 && <Rail title="Water & drinks" to="/shop/water-drinks-wines">{d.drinks.map((p: any) => <ProductCard key={p.id} product={p} />)}</Rail>}

      {d && d.stays.length > 0 && (
        <Rail title="Stay with Nimpat" to="/apartments">
          {d.stays.map((p: any) => (
            <Link key={p.id} to={`/apartments/${p.slug}`} className="card wide">
              <div className="card-photo"><Photo src={p.image} alt={p.name} /></div>
              <div className="card-body">
                <strong>{p.name}</strong>
                <small>{[p.location, p.city].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')}</small>
                {p.nightlyFromMinor !== null && <span className="price">From {formatNaira(p.roomFromMinor ?? p.nightlyFromMinor)} <small>a night</small></span>}
              </div>
            </Link>
          ))}
        </Rail>
      )}

      {d && d.pharmacy.length > 0 && <Rail title="Pharmacy" to="/pharmacy">{d.pharmacy.map((p: any) => <ProductCard key={p.id} product={p} />)}</Rail>}

      {d && d.cars.length > 0 && (
        <Rail title="Cars" to="/cars">
          {d.cars.map((v: any) => (
            <Link key={v.id} to={`/cars/${v.slug}`} className="card wide">
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
        <Rail title="A little time for you" to="/spa">
          {d.spa.map((t: any) => (
            <Link key={t.id} to={`/spa/${t.slug}`} className="card wide">
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
    </div>
  );
}

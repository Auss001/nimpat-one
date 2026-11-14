import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatNaira, get, rows } from '../api';
import { pharmacyAllowed } from '../platform';
import { Empty, FavButton, PageTitle, Photo, Skeletons, spaImage, useLoad } from '../ui';
import { loadStays } from './Apartments';
import { ProductCard } from './Shop';

/**
 * "Everything at Nimpat" (owner, 14 November 2026): one page with all of Nimpat — drinks, flats, spa, cars,
 * supplies, services — mixed together in a new order on every visit, so it reads like a shop window, not a list.
 * Chips narrow it to one kind; sorting puts prices in order.
 */
type Kind = 'drinks' | 'pharmacy' | 'supplies' | 'stays' | 'spa' | 'cars' | 'services';
const KINDS: { key: Kind; label: string }[] = [
  { key: 'drinks', label: 'Drinks' },
  { key: 'stays', label: 'Apartments' },
  { key: 'spa', label: 'Spa' },
  { key: 'cars', label: 'Cars' },
  { key: 'services', label: 'Services' },
  { key: 'supplies', label: 'Supplies' },
  { key: 'pharmacy', label: 'Pharmacy' },
];

interface Item {
  key: string;
  kind: Kind;
  priceMinor: number | null;
  product?: any; // drinks, pharmacy, supplies: drawn with the shop's own card (add to basket)
  title?: string;
  label?: string;
  image?: string | null;
  to?: string;
  priceNote?: string;
  fav?: { kind: string; slug: string };
}

const SORTS = [
  { key: 'mix', label: 'A bit of everything' },
  { key: 'low', label: 'Price: low to high' },
  { key: 'high', label: 'Price: high to low' },
] as const;
type Sort = (typeof SORTS)[number]['key'];
const PAGE = 24;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function loadEverything(): Promise<Item[]> {
  const none = { data: [] as any[] };
  const products = (division: string, size: number) => (pharmacyAllowed(division) ? get(`/catalog/products?division=${division}&pageSize=${size}`).catch(() => none) : Promise.resolve(none));
  const [drinks, pharmacy, supplies, stays, spa, cars, services] = await Promise.all([
    products('water-drinks-wines', 100),
    products('pharmacy-laboratory', 48),
    products('retail-general-supplies', 48),
    loadStays().catch(() => []),
    get('/spa/treatments?pageSize=100').catch(() => none),
    get('/vehicles?pageSize=50').catch(() => none),
    get('/services').catch(() => []),
  ]);
  const shop = (kind: Kind) => (p: any): Item => ({ key: `p-${p.id}`, kind, priceMinor: num(p.priceFromMinor), product: p });
  return [
    ...rows(drinks).map(shop('drinks')),
    ...rows(pharmacy).map(shop('pharmacy')),
    ...rows(supplies).map(shop('supplies')),
    ...stays.map((s): Item => ({
      key: `s-${s.key}`, kind: 'stays', title: s.name, label: `Apartment · ${s.place}`, image: s.image, to: s.to,
      priceMinor: num(s.unit.nightlyRateMinor), priceNote: 'a night', fav: { kind: 'PROPERTY', slug: s.key },
    })),
    ...rows(spa).map((t: any): Item => ({
      key: `t-${t.id}`, kind: 'spa', title: t.name, label: `Spa · ${t.category ?? 'Treatment'}`, image: spaImage(t), to: `/spa/${t.slug}`,
      priceMinor: num(t.priceMinor), fav: { kind: 'TREATMENT', slug: t.slug },
    })),
    ...rows(cars).map((v: any): Item => ({
      key: `c-${v.id}`, kind: 'cars', title: `${v.year} ${v.make} ${v.model}`, label: 'Car', image: v.images?.[0]?.url, to: `/cars/${v.slug}`,
      priceMinor: num(v.priceMinor), fav: { kind: 'VEHICLE', slug: v.slug },
    })),
    ...rows(services).filter((o: any) => pharmacyAllowed(o.division?.slug)).map((o: any): Item => ({
      key: `o-${o.id}`, kind: 'services', title: o.name, label: o.category ?? o.division?.name ?? 'Service', image: o.imageUrl,
      to: `/services/${o.division?.slug}${o.category ? `?category=${encodeURIComponent(o.category)}` : ''}`,
      priceMinor: o.pricingType === 'QUOTE_REQUIRED' ? null : num(o.basePriceMinor), priceNote: o.pricingType === 'STARTING_FROM' ? 'from' : undefined,
    })),
  ];
}

/** Shuffles each kind, then deals them out in turn (in a shuffled kind order), so neighbours are different things. */
function mix(items: Item[]): Item[] {
  const shuffle = <T,>(a: T[]) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  const piles = shuffle(KINDS.map((k) => shuffle(items.filter((i) => i.kind === k.key))).filter((p) => p.length));
  const out: Item[] = [];
  while (piles.some((p) => p.length)) for (const p of piles) if (p.length) out.push(p.shift()!);
  return out;
}

function ItemCard({ item }: { item: Item }) {
  if (item.product) return <ProductCard product={item.product} />;
  return (
    <Link to={item.to!} className="card">
      {item.fav && <FavButton kind={item.fav.kind} slug={item.fav.slug} />}
      <div className="card-photo square"><Photo src={item.image} alt={item.title ?? ''} /></div>
      <div className="card-body">
        <strong>{item.title}</strong>
        <small>{item.label}</small>
        {item.priceMinor === null
          ? <span className="price muted">Ask for price</span>
          : <span className="price">{item.priceNote === 'from' ? 'From ' : ''}{formatNaira(item.priceMinor)}{item.priceNote === 'a night' && <small> a night</small>}</span>}
      </div>
    </Link>
  );
}

export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const everything = useLoad(loadEverything, []);
  // A fresh mix on every visit; it stays put while the customer browses the page.
  const mixed = useMemo(() => mix(everything.data ?? []), [everything.data]);
  const kind = (params.get('kind') ?? '') as Kind | '';
  const sort = (params.get('sort') ?? 'mix') as Sort;
  const [shown, setShown] = useState(PAGE);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setShown(PAGE);
  };
  const present = new Set(mixed.map((i) => i.kind));
  const list = useMemo(() => {
    const picked = mixed.filter((i) => !kind || i.kind === kind);
    if (sort === 'mix') return picked;
    const dir = sort === 'low' ? 1 : -1;
    return [...picked].sort((a, b) => (a.priceMinor === null ? 1 : b.priceMinor === null ? -1 : dir * (a.priceMinor - b.priceMinor)));
  }, [mixed, kind, sort]);

  return (
    <>
      <PageTitle title="Everything at Nimpat" sub="Amazing prices, quick delivery. Drinks, stays, spa, cars and more." />
      <div className="chips" role="group" aria-label="What to show">
        <button className={!kind ? 'on' : ''} onClick={() => set('kind', '')}>All</button>
        {KINDS.filter((k) => present.has(k.key)).map((k) => (
          <button key={k.key} className={kind === k.key ? 'on' : ''} onClick={() => set('kind', k.key)}>{k.label}</button>
        ))}
      </div>
      <div className="explore-bar">
        <span className="muted-text">{everything.data ? `${list.length} to choose from` : ' '}</span>
        <label className="explore-sort">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => set('sort', e.target.value === 'mix' ? '' : e.target.value)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {everything.loading && !everything.data && <Skeletons />}
      {everything.data && list.length === 0 && <Empty title="Nothing here yet" action={<Link className="btn primary" to="/">Back to home</Link>} />}
      <div className="grid">{list.slice(0, shown).map((i) => <ItemCard key={i.key} item={i} />)}</div>
      {list.length > shown && <button className="btn ghost full explore-more" onClick={() => setShown((n) => n + PAGE)}>Show more</button>}
    </>
  );
}

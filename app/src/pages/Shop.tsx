import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CalendarCheck, ChevronRight, FlaskConical, Minus, Plus, Search as SearchIcon, ShieldCheck, Stethoscope } from 'lucide-react';
import { formatNaira, get, getSession, post, rows } from '../api';
import { CallLink, Empty, FavButton, forgetSearches, Loader, Note, PageTitle, Photo, recentSearches, rememberSearch, rememberViewed, Sheet, Skeletons, useCart, useLoad, useToast } from '../ui';

const DIVISION_TITLE: Record<string, { title: string; sub: string }> = {
  'water-drinks-wines': { title: 'Water & Drinks', sub: 'Water, soft drinks, juices, wines and spirits.' },
  'pharmacy-laboratory': { title: 'Pharmacy', sub: 'Everyday health, reviewed by our pharmacist.' },
  'retail-general-supplies': { title: 'Supplies', sub: 'Office, safety and cleaning supplies.' },
};
const AGE_KEY = 'nimpat-one-age-confirmed';

function ageConfirmed() {
  try {
    return sessionStorage.getItem(AGE_KEY) === 'yes';
  } catch {
    return false;
  }
}

/** Adds to the basket, with an 18+ confirmation for alcohol. No sign-in needed. */
function useAddToBasket() {
  const { refresh, addLocal } = useCart();
  const toast = useToast();
  const [askAge, setAskAge] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);

  const add = async (variantId: string, quantity: number, name: string) => {
    setBusy(true);
    try {
      await post('/carts/items', { variantId, quantity });
      await refresh();
      toast(`${name} added to your basket`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const request = (product: any, variantId: string, quantity = 1) => {
    // A visitor shops straight away; their details are asked for once, at checkout.
    const go = () => {
      if (getSession()) void add(variantId, quantity, product.name);
      else {
        addLocal(product, variantId, quantity);
        toast(`${product.name} added to your basket`);
      }
    };
    if (product.isAgeRestricted && !ageConfirmed()) {
      setAskAge(() => go);
      return;
    }
    go();
  };
  const dialog = askAge ? (
    <Sheet title="Are you 18 or older?" onClose={() => setAskAge(null)}>
      <p>This product contains alcohol and is only sold to adults aged 18 and over. You may be asked for ID on delivery.</p>
      <div className="row">
        <button className="btn ghost" onClick={() => setAskAge(null)}>No</button>
        <button className="btn primary" onClick={() => { try { sessionStorage.setItem(AGE_KEY, 'yes'); } catch { /* Asked again next time. */ } const run = askAge; setAskAge(null); run(); }}>Yes, I am 18 or older</button>
      </div>
    </Sheet>
  ) : null;
  return { request, dialog, busy };
}

function priceLabel(p: any) {
  if (p.priceFromMinor === null || p.priceFromMinor === undefined) return <span className="price muted">Contact for price</span>;
  const many = p.variants?.length > 1 && p.variants.some((v: any) => v.unitPriceMinor !== p.priceFromMinor);
  return <span className="price">{many ? 'From ' : ''}{formatNaira(p.priceFromMinor)}</span>;
}

export function ProductCard({ product: p }: { product: any }) {
  const { request, dialog, busy } = useAddToBasket();
  const variant = p.variants?.find((v: any) => v.purchasable);
  const single = p.variants?.length === 1;
  return (
    <article className="card">
      <Link to={`/product/${p.slug}`} className="card-link" aria-label={p.name}>
        <div className="card-photo square"><Photo src={p.images?.[0]?.url} alt={p.name} fit="contain" /></div>
        <div className="card-body">
          <strong>{p.name}</strong>
          <small>{p.variants?.[0]?.name !== 'As listed' ? p.variants?.[0]?.name : p.category?.name}</small>
          {priceLabel(p)}
          {!p.inStock && <small className="out">Out of stock</small>}
        </div>
      </Link>
      <FavButton kind="PRODUCT" slug={p.slug} />
      {p.isAgeRestricted && <span className="tag">18+</span>}
      {variant && single && <button className="add" aria-label={`Add ${p.name} to basket`} disabled={busy} onClick={() => request(p, variant.id)}><Plus size={20} /></button>}
      {dialog}
    </article>
  );
}

function ProductGrid({ products }: { products: any[] }) {
  return <div className="grid">{products.map((p) => <ProductCard key={p.id} product={p} />)}</div>;
}

/** Reads a product list from the API, by page, as the customer scrolls on. */
function useProducts(query: string) {
  const [pages, setPages] = useState<any[]>([]);
  const [meta, setMeta] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async (page: number) => {
    setLoading(true);
    try {
      const r = await get(`/catalog/products?pageSize=24&page=${page}&${query}`);
      setPages((p) => (page === 1 ? r.data : [...p, ...r.data]));
      setMeta(r.meta);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setPages([]);
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return { products: pages, meta, loading, error, more: () => meta && void load(meta.page + 1) };
}

function ProductList({ division, extra, emptyText, initialCategory = '' }: { division: string; extra?: React.ReactNode; emptyText: string; initialCategory?: string }) {
  const [category, setCategory] = useState(initialCategory);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const cats = useLoad(() => get(`/catalog/categories?division=${division}`).then(rows).catch(() => [] as any[]), [division]);
  const query = useMemo(() => new URLSearchParams({ division, ...(category ? { category } : {}), ...(q ? { q } : {}) }).toString(), [division, category, q]);
  const { products, meta, loading, error, more } = useProducts(query);
  return (
    <>
      <div className="search-box"><SearchIcon size={17} aria-hidden="true" /><input aria-label="Search products" placeholder="Search here" value={text} onChange={(e) => setText(e.target.value)} /></div>
      {(cats.data?.length ?? 0) > 1 && (
        <div className="chips" role="group" aria-label="Categories">
          <button className={!category ? 'on' : ''} onClick={() => setCategory('')}>All</button>
          {cats.data!.map((c) => <button key={c.id} className={category === c.slug ? 'on' : ''} onClick={() => setCategory(c.slug)}>{c.name}</button>)}
        </div>
      )}
      {extra}
      {error && <Note tone="error">{error}</Note>}
      {!error && !loading && products.length === 0 && <Empty title={q || category ? 'Nothing matches that' : 'Coming soon'}>{q || category ? 'Try another word or category.' : emptyText}</Empty>}
      <ProductGrid products={products} />
      {loading && products.length === 0 && <Skeletons />}
      {loading && products.length > 0 && <Loader />}
      {!loading && meta && meta.page < meta.totalPages && <button className="btn ghost full" onClick={more}>Show more</button>}
    </>
  );
}

export function ShopPage() {
  const { division = '' } = useParams();
  const info = DIVISION_TITLE[division] ?? { title: 'Shop', sub: '' };
  const [params] = useSearchParams();
  const initialCategory = params.get('category') ?? '';
  return (
    <>
      <PageTitle title={info.title} sub={info.sub} />
      <ProductList key={`${division}-${initialCategory}`} division={division} initialCategory={initialCategory} emptyText="Our team is confirming these products and prices." />
    </>
  );
}

export function PharmacyPage() {
  return (
    <>
      <PageTitle title="Pharmacy" sub="Everyday health, reviewed by our pharmacist." />
      <div className="action-pair">
        <Link to="/services/pharmacy-laboratory" className="action-card green"><Stethoscope size={22} aria-hidden="true" /><span><b>Book a pharmacist</b><small>Consultation or prescription review</small></span></Link>
        <Link to="/services/pharmacy-laboratory" className="action-card teal"><FlaskConical size={22} aria-hidden="true" /><span><b>Book a lab test</b><small>Tell us which test you need</small></span></Link>
      </div>
      <Note>Medicine information here is for general reference only. It is not a diagnosis or treatment advice. Please speak to a pharmacist or doctor about your health.</Note>
      <ProductList division="pharmacy-laboratory" emptyText="Our pharmacist is reviewing each product before it appears here." />
    </>
  );
}

export function ProductPage() {
  const { slug = '' } = useParams();
  const product = useLoad(() => get(`/catalog/products/${slug}`), [slug]);
  const { request, dialog, busy } = useAddToBasket();
  const [variantId, setVariantId] = useState('');
  const [qty, setQty] = useState(1);
  const [photo, setPhoto] = useState(0);
  const p = product.data;
  useEffect(() => {
    if (!p) return;
    setVariantId(p.variants.find((v: any) => v.purchasable)?.id ?? p.variants[0]?.id ?? '');
    rememberViewed({ slug: p.slug, name: p.name, image: p.images?.[0]?.url });
  }, [p]);
  if (product.loading && !p) return <Loader />;
  if (!p) return <><PageTitle title="Not available" /><Empty title="This item is not available right now">It may be awaiting confirmation.</Empty></>;
  const v = p.variants.find((x: any) => x.id === variantId) ?? p.variants[0];
  const isPharmacy = p.prescriptionStatus !== null && p.prescriptionStatus !== undefined;
  const needsPrescription = p.prescriptionStatus === 'REQUIRED' || p.prescriptionStatus === 'RESTRICTED';
  const images = p.images.filter((i: any) => !i.variantId || i.variantId === v?.id);
  const shown = images[photo] ?? images[0];
  return (
    <article className="detail">
      <PageTitle title={p.name} sub={[p.brand, p.category?.name].filter(Boolean).join(' · ')} action={<FavButton kind="PRODUCT" slug={p.slug} inline />} />
      <div className="detail-grid">
        <div>
          <div className="detail-photo square"><Photo src={shown?.url} alt={p.name} fit="contain" /></div>
          {images.length > 1 && (
            <div className="thumbs">{images.map((i: any, n: number) => <button key={i.id} className={n === photo ? 'on' : ''} aria-label={`Photo ${n + 1}`} onClick={() => setPhoto(n)}><img src={i.url} alt="" /></button>)}</div>
          )}
        </div>
        <div className="detail-side">
          {p.variants.length > 1 && (
            <div className="chips" role="group" aria-label="Size or pack">
              {p.variants.map((x: any) => <button key={x.id} className={x.id === variantId ? 'on' : ''} onClick={() => { setVariantId(x.id); setPhoto(0); }}>{x.name}</button>)}
            </div>
          )}
          {p.variants.length === 1 && v?.name !== 'As listed' && <p className="pack">{v?.name}</p>}
          <p className="big-price">{v?.unitPriceMinor !== null && v?.unitPriceMinor !== undefined ? formatNaira(v.unitPriceMinor) : 'Contact for price'}</p>
          {v?.unitPriceMinor != null && v.unitsPerPack > 1 && <p className="muted-text">About {formatNaira(Math.round(v.unitPriceMinor / v.unitsPerPack))} each</p>}
          <p className={p.inStock ? 'stock ok' : 'stock out'}>{p.inStock ? 'In stock' : 'Out of stock'}</p>
          {p.isAgeRestricted && <Note tone="warn">Contains alcohol. Only sold to adults aged 18 and over.</Note>}
          {needsPrescription && <Note tone="warn"><ShieldCheck size={16} aria-hidden="true" /> This medicine needs a pharmacist and prescription review, so it cannot be bought online.</Note>}
          {v?.purchasable ? (
            <div className="buy-row">
              <div className="qty">
                <button aria-label="Fewer" disabled={qty <= (v.minOrderQty ?? 1)} onClick={() => setQty((n) => n - 1)}><Minus size={16} /></button>
                <span aria-live="polite">{qty}</span>
                <button aria-label="More" disabled={v.maxOrderQty ? qty >= v.maxOrderQty : false} onClick={() => setQty((n) => n + 1)}><Plus size={16} /></button>
              </div>
              <button className="btn primary grow" disabled={busy} onClick={() => request(p, v.id, qty)}>Add to basket</button>
            </div>
          ) : (
            <>
              {!needsPrescription && v?.purchaseNote && <Note>{v.purchaseNote}</Note>}
              {needsPrescription ? <Link className="btn primary" to="/services/pharmacy-laboratory"><CalendarCheck size={16} aria-hidden="true" /> Book a pharmacist</Link> : <CallLink />}
            </>
          )}
          {p.description && <section className="desc"><h2>About this product</h2><p>{p.description}</p></section>}
          {isPharmacy && <Note>This information is for general reference only. It is not a diagnosis or treatment advice. Always read the label and ask a pharmacist or doctor.</Note>}
        </div>
      </div>
      {dialog}
    </article>
  );
}

/** Words that mean a whole section of the app. */
const SECTIONS: { to: string; label: string; words: string[]; key?: 'stays' | 'cars' | 'spa' }[] = [
  { to: '/spa', label: 'Spa & Wellness', words: ['spa', 'massage', 'facial', 'wellness', 'beauty', 'salon', 'saloon', 'nails', 'braces'], key: 'spa' },
  { to: '/apartments', label: 'Luxury Apartments', words: ['apartment', 'apartments', 'flat', 'flats', 'stay', 'shortlet', 'short let', 'hotel', 'room', 'rooms', 'mabushi'], key: 'stays' },
  { to: '/cars', label: 'Cars', words: ['car', 'cars', 'vehicle', 'vehicles', 'auto', 'automobile', 'automobiles'], key: 'cars' },
  { to: '/pharmacy', label: 'Pharmacy', words: ['pharmacy', 'medicine', 'medicines', 'drug', 'drugs', 'chemist'] },
  { to: '/services/pharmacy-laboratory', label: 'Laboratory', words: ['lab', 'laboratory', 'test', 'tests'] },
  { to: '/shop/water-drinks-wines', label: 'Drinks', words: ['drinks', 'drink', 'wine', 'wines', 'spirits', 'whisky', 'whiskey', 'champagne'] },
  { to: '/shop/water-drinks-wines?category=water', label: 'Water', words: ['water'] },
  { to: '/shop/retail-general-supplies', label: 'Supplies', words: ['supplies', 'supply', 'retail'] },
];

/** A section matches when the search is one of its words, or the start of one (at least three letters). */
function sectionsFor(q: string) {
  const t = q.trim().toLowerCase();
  if (t.length < 2) return [];
  return SECTIONS.filter((x) => x.words.some((w) => w === t || (t.length >= 3 && w.startsWith(t))) || x.label.toLowerCase() === t);
}

/** One search across products, stays, cars and treatments. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [text, setText] = useState(initial);
  const [recent, setRecent] = useState(recentSearches);
  useEffect(() => setText(initial), [initial]);
  useEffect(() => {
    const t = setTimeout(() => setParams(text.trim() ? { q: text.trim() } : {}, { replace: true }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const results = useLoad(async () => {
    const q = initial.toLowerCase();
    if (!q) return null;
    rememberSearch(initial);
    const none = { data: [] as any[] };
    const [products, stays, cars, spa] = await Promise.all([
      get(`/catalog/products?pageSize=24&q=${encodeURIComponent(initial)}`).catch(() => none),
      get('/apartments/properties?pageSize=100').catch(() => none),
      get('/vehicles?pageSize=100').catch(() => none),
      get('/spa/treatments?pageSize=100').catch(() => none),
    ]);
    const has = (...s: (string | null | undefined)[]) => s.some((x) => x?.toLowerCase().includes(q));
    // Searching a section's name shows everything in it.
    const whole = new Set(sectionsFor(q).map((x) => x.key));
    return {
      products: products.data,
      stays: rows(stays).filter((p: any) => whole.has('stays') || has(p.name, p.city, p.location)),
      cars: rows(cars).filter((v: any) => whole.has('cars') || has(v.make, v.model, String(v.year))),
      spa: rows(spa).filter((t: any) => whole.has('spa') || has(t.name, t.category, t.description)),
    };
  }, [initial]);
  const r = results.data;
  const sections = sectionsFor(initial);
  const nothing = r && !sections.length && !r.products.length && !r.stays.length && !r.cars.length && !r.spa.length;
  return (
    <>
      <PageTitle title="Search" back={false} />
      <div className="search-box"><SearchIcon size={17} aria-hidden="true" /><input autoFocus aria-label="Search Nimpat One" placeholder="Water, medicine, apartments, cars, spa…" value={text} onChange={(e) => setText(e.target.value)} /></div>
      {results.loading && initial && <Loader label="Searching" />}
      {!initial && recent.length > 0 && (
        <section>
          <div className="rail-head"><h2>Recent</h2><button className="text-link" onClick={() => { forgetSearches(); setRecent([]); }}>Clear</button></div>
          <div className="chips wrap">{recent.map((r) => <button key={r} onClick={() => setText(r)}>{r}</button>)}</div>
        </section>
      )}
      <section>
        {!initial && <div className="chips wrap">{['Water', 'Champagne', 'Whisky', 'Paracetamol', 'Toyota', 'Massage', 'Mabushi'].map((s) => <button key={s} onClick={() => setText(s)}>{s}</button>)}</div>}
      </section>
      {nothing && <Empty title={`Nothing found for "${initial}"`}>Try another word.</Empty>}
      {sections.length > 0 && <div className="chips wrap section-hits" aria-label="Go to">{sections.map((x) => <Link key={x.to} to={x.to} className="chip-link">{x.label} <ChevronRight size={15} aria-hidden="true" /></Link>)}</div>}
      {r && !sections.length && r.products.length > 0 && <><h2 className="group-title">Products</h2><ProductGrid products={r.products} /></>}
      {r && r.stays.length > 0 && <><h2 className="group-title">Luxury Apartments</h2><div className="list">{r.stays.map((p: any) => <Link key={p.id} to={`/apartments/${p.slug}`} className="row-card"><b>{p.name}</b><small>{p.location ?? p.city}</small></Link>)}</div></>}
      {r && r.cars.length > 0 && <><h2 className="group-title">Cars</h2><div className="list">{r.cars.map((v: any) => <Link key={v.id} to={`/cars/${v.slug}`} className="row-card"><b>{v.year} {v.make} {v.model}</b><small>{v.priceMinor !== null ? formatNaira(v.priceMinor) : 'Contact for price'}</small></Link>)}</div></>}
      {r && r.spa.length > 0 && <><h2 className="group-title">Spa & Wellness</h2><div className="list">{r.spa.map((t: any) => <Link key={t.id} to={`/spa/${t.slug}`} className="row-card"><b>{t.name}</b><small>{formatNaira(t.priceMinor)}</small></Link>)}</div></>}
      {r && sections.length > 0 && r.products.length > 0 && <><h2 className="group-title">Products</h2><ProductGrid products={r.products} /></>}
    </>
  );
}

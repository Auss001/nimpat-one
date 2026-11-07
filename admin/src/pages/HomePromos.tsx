import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Trash2, Upload } from 'lucide-react';
import { del, get, patch, post, put, upload } from '../api';
import { Field, Loading, Modal, PageHead, Pill, useAction, useConfirm, useLoad } from '../components/ui';

type Kind = 'PICTURE' | 'PRODUCT' | 'APARTMENTS';
interface Slide {
  id: string;
  kind: Kind;
  title: string | null;
  subtitle: string | null;
  buttonText: string | null;
  imageUrl: string | null;
  linkTo: string | null;
  productId: string | null;
  tone: string;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  product?: { name: string; slug: string; status: string; images: { url: string }[] } | null;
}

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'PICTURE', label: 'Promo picture', hint: 'Your flyer or banner, with an optional heading.' },
  { value: 'PRODUCT', label: 'Featured product', hint: 'The name, picture and live price come from the product.' },
  { value: 'APARTMENTS', label: 'Luxury Apartments', hint: 'Uses a flat’s photo and its live nightly price.' },
];
const TONES: { value: string; label: string }[] = [
  { value: 'sky', label: 'Sky blue' },
  { value: 'rose', label: 'Rose' },
  { value: 'gold', label: 'Gold' },
  { value: 'mint', label: 'Mint' },
  { value: 'violet', label: 'Violet' },
];
const LINKS: { value: string; label: string }[] = [
  { value: '', label: 'Nothing, picture only' },
  { value: '/shop/water-drinks-wines', label: 'Water, drinks and wines' },
  { value: '/shop/water-drinks-wines?category=water', label: 'Water' },
  { value: '/pharmacy', label: 'Pharmacy' },
  { value: '/apartments', label: 'Luxury Apartments' },
  { value: '/spa', label: 'Spa' },
  { value: '/cars', label: 'Cars' },
  { value: '/shop/retail-general-supplies', label: 'Supplies' },
];
const CUSTOM = 'custom';

function statusOf(s: Slide): { label: string; tone: 'green' | 'amber' | undefined } {
  const now = Date.now();
  if (!s.isActive) return { label: 'Hidden', tone: undefined };
  if (s.endsAt && new Date(s.endsAt).getTime() <= now) return { label: 'Finished', tone: undefined };
  if (s.startsAt && new Date(s.startsAt).getTime() > now) return { label: 'Scheduled', tone: 'amber' };
  if (s.kind === 'PRODUCT' && s.product?.status !== 'ACTIVE') return { label: 'Product not on sale', tone: 'amber' };
  return { label: 'Showing', tone: 'green' };
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'medium' });

/** A small copy of how the slide looks to customers, including how a picture gets cropped. */
function Preview({ kind, imageUrl, title, subtitle, tone, productName, productImage }: { kind: Kind; imageUrl?: string | null; title?: string | null; subtitle?: string | null; tone: string; productName?: string; productImage?: string }) {
  if (kind === 'PICTURE') {
    return (
      <div className="promo-preview">
        {imageUrl ? <img src={imageUrl} alt="" /> : <span className="promo-empty">No picture yet</span>}
        {title && <span className="promo-over"><small>{subtitle}</small><b>{title}</b></span>}
      </div>
    );
  }
  if (kind === 'APARTMENTS') return <div className="promo-preview tone-forest"><span className="promo-over plain"><small>{subtitle}</small><b>{title || 'Luxury Apartments'}</b></span></div>;
  return (
    <div className={`promo-preview tone-${tone}`}>
      <span className="promo-over plain dark"><small>{subtitle}</small><b>{productName || 'Choose a product'}</b></span>
      {productImage && <img className="promo-product" src={productImage} alt="" />}
    </div>
  );
}

function SlideForm({ slide, onClose, onSaved }: { slide: Slide | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [kind, setKind] = useState<Kind>(slide?.kind ?? 'PICTURE');
  const [title, setTitle] = useState(slide?.title ?? '');
  const [subtitle, setSubtitle] = useState(slide?.subtitle ?? '');
  const [buttonText, setButtonText] = useState(slide?.buttonText ?? '');
  const [imageUrl, setImageUrl] = useState(slide?.imageUrl ?? '');
  const known = LINKS.some((l) => l.value === (slide?.linkTo ?? ''));
  const [linkChoice, setLinkChoice] = useState(known ? slide?.linkTo ?? '' : CUSTOM);
  const [customLink, setCustomLink] = useState(known ? '' : slide?.linkTo ?? '');
  const [tone, setTone] = useState(slide?.tone ?? 'sky');
  const [product, setProduct] = useState<{ id: string; name: string; image?: string } | null>(slide?.productId && slide.product ? { id: slide.productId, name: slide.product.name, image: slide.product.images[0]?.url } : null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [startsAt, setStartsAt] = useState(slide?.startsAt?.slice(0, 10) ?? '');
  const [endsAt, setEndsAt] = useState(slide?.endsAt?.slice(0, 10) ?? '');
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      get<{ data: any[] }>(`/admin/catalog/products?status=ACTIVE&pageSize=8&q=${encodeURIComponent(q)}`)
        .then((r) => live && setResults(r.data))
        .catch(() => live && setResults([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [search]);

  const pick = (f?: File) => {
    if (f) void run(async () => setImageUrl((await upload<{ url: string }>('/admin/home-slides/upload', f)).url), 'Picture added');
  };
  const orNull = (v: string) => v.trim() || null;
  const save = () =>
    run(async () => {
      const body = {
        kind,
        title: kind === 'PRODUCT' ? null : orNull(title),
        subtitle: orNull(subtitle),
        buttonText: kind === 'PICTURE' ? orNull(buttonText) : null,
        imageUrl: kind === 'PICTURE' ? orNull(imageUrl) : null,
        linkTo: kind === 'PICTURE' ? orNull(linkChoice === CUSTOM ? customLink : linkChoice) : null,
        productId: kind === 'PRODUCT' ? product?.id ?? null : null,
        tone,
        // A promo starts at the beginning of its first day and runs to the end of its last day.
        startsAt: startsAt ? new Date(`${startsAt}T00:00:00+01:00`).toISOString() : null,
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59+01:00`).toISOString() : null,
      };
      if (slide) await patch(`/admin/home-slides/${slide.id}`, body);
      else await post('/admin/home-slides', body);
      onSaved();
      onClose();
    }, 'Saved. The home page is updated.');

  return (
    <Modal
      wide
      title={slide ? 'Edit slide' : 'Add a slide'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></>}
    >
      <div className="promo-form">
        <div className="promo-fields">
          <Field label="Type of slide" hint={KINDS.find((k) => k.value === kind)?.hint}>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>

          {kind === 'PICTURE' && (
            <>
              <Field label="Picture" hint="Best at 1600 x 1000 pixels. On a square flyer, only the top part shows, so keep the headline near the top.">
                <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
                <button className="btn" type="button" disabled={busy} onClick={() => file.current?.click()}><Upload size={15} aria-hidden="true" /> {imageUrl ? 'Change picture' : 'Choose picture'}</button>
              </Field>
              <Field label="When tapped, go to">
                <select value={linkChoice} onChange={(e) => setLinkChoice(e.target.value)}>
                  {LINKS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  <option value={CUSTOM}>Another page or web address</option>
                </select>
              </Field>
              {linkChoice === CUSTOM && <Field label="Page or web address" hint="For example /product/swan-natural-spring-water-75cl or https://nimpatgroup.com"><input value={customLink} onChange={(e) => setCustomLink(e.target.value)} /></Field>}
              <Field label="Button text (optional)"><input maxLength={24} placeholder="See prices" value={buttonText} onChange={(e) => setButtonText(e.target.value)} /></Field>
              <Field label="Heading over the picture (optional)" hint="Leave blank if the picture already has its own words."><input maxLength={70} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            </>
          )}

          {kind === 'PRODUCT' && (
            <>
              <Field label="Product">
                {product && <p className="promo-chosen"><b>{product.name}</b> <button className="btn link sm" type="button" onClick={() => setProduct(null)}>Change</button></p>}
                {!product && (
                  <>
                    <input placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
                    {results.length > 0 && (
                      <div className="promo-results">
                        {results.map((p) => (
                          <button key={p.id} type="button" onClick={() => { setProduct({ id: p.id, name: p.name, image: p.images?.[0]?.url }); setSearch(''); }}>
                            {p.images?.[0]?.url && <img src={p.images[0].url} alt="" />} {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Field>
              <Field label="Background">
                <select value={tone} onChange={(e) => setTone(e.target.value)}>
                  {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
            </>
          )}

          {kind === 'APARTMENTS' && <Field label="Heading (optional)"><input maxLength={70} placeholder="Luxury Apartments" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>}

          <Field label={kind === 'PRODUCT' ? 'Small label (optional)' : 'Small line of text (optional)'}><input maxLength={70} placeholder={kind === 'PRODUCT' ? 'Featured' : ''} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></Field>

          <div className="promo-dates">
            <Field label="Start date (optional)"><input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
            <Field label="End date (optional)" hint="It disappears by itself after this day."><input type="date" min={startsAt || undefined} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></Field>
          </div>
        </div>
        <div>
          <p className="muted small" style={{ marginTop: 0 }}>How it will look</p>
          <Preview kind={kind} imageUrl={imageUrl} title={title} subtitle={subtitle} tone={tone} productName={product?.name} productImage={product?.image} />
        </div>
      </div>
    </Modal>
  );
}

export function HomePromosPage() {
  const list = useLoad(() => get<Slide[]>('/admin/home-slides'), []);
  const { run, busy } = useAction();
  const { ask, dialog } = useConfirm();
  const [editing, setEditing] = useState<Slide | 'new' | null>(null);
  const slides = list.data ?? [];

  const move = (i: number, by: number) => {
    const ids = slides.map((s) => s.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void run(async () => {
      await put('/admin/home-slides/order', { ids });
      await list.reload();
    });
  };
  const toggle = (s: Slide) =>
    void run(async () => {
      await patch(`/admin/home-slides/${s.id}`, { isActive: !s.isActive });
      await list.reload();
    }, s.isActive ? 'Hidden from the home page' : 'Showing on the home page');
  const remove = (s: Slide) =>
    ask('Delete this slide? This cannot be undone. To keep it for later, hide it instead.', () => {
      void run(async () => {
        await del(`/admin/home-slides/${s.id}`);
        await list.reload();
      }, 'Slide deleted');
    }, 'Delete slide');

  return (
    <>
      <PageHead
        title="Home promos"
        subtitle="The sliding promos and featured items at the top of the customer home page, in this order."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>Add a slide</button>}
      />
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && slides.length === 0 && <div className="card card-pad empty">No slides yet, so customers see no promos. Add your first one.</div>}
      <div className="promo-list">
        {slides.map((s, i) => {
          const status = statusOf(s);
          return (
            <article key={s.id} className="card promo-card">
              <Preview kind={s.kind} imageUrl={s.imageUrl} title={s.title} subtitle={s.subtitle} tone={s.tone} productName={s.product?.name} productImage={s.product?.images[0]?.url} />
              <div className="promo-info">
                <div><strong>{s.kind === 'PRODUCT' ? s.product?.name : s.title || KINDS.find((k) => k.value === s.kind)?.label}</strong> <Pill tone={status.tone}>{status.label}</Pill></div>
                <span className="muted small">
                  {s.startsAt || s.endsAt ? [s.startsAt && `From ${dateText(s.startsAt)}`, s.endsAt && `until ${dateText(s.endsAt)}`].filter(Boolean).join(' ') : 'No end date'}
                </span>
                <div className="promo-actions">
                  <button className="btn sm" aria-label="Move earlier" disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                  <button className="btn sm" aria-label="Move later" disabled={busy || i === slides.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
                  <button className="btn sm" disabled={busy} onClick={() => toggle(s)}>{s.isActive ? 'Hide' : 'Show'}</button>
                  <button className="btn sm" onClick={() => setEditing(s)}><Pencil size={13} aria-hidden="true" /> Edit</button>
                  <button className="btn sm" aria-label="Delete slide" disabled={busy} onClick={() => remove(s)}><Trash2 size={13} aria-hidden="true" /></button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {editing && <SlideForm slide={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void list.reload()} />}
      {dialog}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useAccess } from '../access';
import { get, getAll, patch, post } from '../api';
import { BulkPhotoUpload, PhotoManager } from '../components/PhotoManager';
import { PriceListUpload } from '../components/PriceListUpload';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira, slugify } from '../money';

interface Variant {
  id: string;
  sku: string;
  name: string;
  unitPriceMinor: number | null;
  isActive: boolean;
  availableQuantity: number;
  minOrderQty: number;
  recordedStockQty: number | null;
  recordedStockAt: string | null;
}
interface Product {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  verification: 'VERIFIED' | 'AWAITING_CONFIRMATION' | 'DEV_SAMPLE';
  isAgeRestricted: boolean;
  listedAvailability: 'IN_STOCK' | 'OUT_OF_STOCK' | null;
  purchaseEnabled: boolean;
  prescriptionStatus: Prescription | null;
  pharmacistApprovedAt: string | null;
  verificationNote: string | null;
  category: { id: string; name: string } | null;
  images: { id: string; url: string }[];
  variants: Variant[];
  createdAt?: string;
}
type Prescription = 'NOT_REVIEWED' | 'NOT_REQUIRED' | 'REQUIRED' | 'RESTRICTED';
const PRESCRIPTION: Record<Prescription, string> = {
  NOT_REVIEWED: 'Not reviewed',
  NOT_REQUIRED: 'No prescription needed',
  REQUIRED: 'Prescription required',
  RESTRICTED: 'Restricted',
};

/** Availability in plain terms. A list or an old count is never shown as live stock. */
function StockCell({ product, variant }: { product: Product; variant: Variant }) {
  if (product.listedAvailability === 'IN_STOCK') return <><Pill tone="green">In stock</Pill><div className="muted small">Always available to order</div></>;
  if (product.listedAvailability === 'OUT_OF_STOCK') return <span className="pill red">Out of stock</span>;
  // "Use the stock count": the counted number decides.
  if (variant.availableQuantity > 0) return <>{variant.availableQuantity}<div className="muted small">Counted</div></>;
  return <><span className="pill red">Out of stock</span><div className="muted small">Count is 0{variant.recordedStockQty !== null ? ` · list said ${variant.recordedStockQty} (guide only)` : ''}</div></>;
}

interface Category {
  id: string;
  name: string;
}

type StatusTab = 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'ALL';

type SortKey = 'category' | 'name' | 'name-desc' | 'price' | 'price-desc' | 'newest' | 'stock';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'category', label: 'Sort: by category' },
  { value: 'name', label: 'Sort: name A to Z' },
  { value: 'name-desc', label: 'Sort: name Z to A' },
  { value: 'price', label: 'Sort: price, lowest first' },
  { value: 'price-desc', label: 'Sort: price, highest first' },
  { value: 'stock', label: 'Sort: most in stock first' },
  { value: 'newest', label: 'Sort: newest first' },
];
type ShowKey = 'all' | 'priced' | 'unpriced' | 'photo' | 'no-photo' | 'in-stock' | 'out-of-stock' | 'needs-approval';
const SHOWS: { value: ShowKey; label: string; pharmacyOnly?: boolean }[] = [
  { value: 'all', label: 'Show: everything' },
  { value: 'priced', label: 'Show: with a price' },
  { value: 'unpriced', label: 'Show: no price yet' },
  { value: 'photo', label: 'Show: with a photo' },
  { value: 'no-photo', label: 'Show: no photo yet' },
  { value: 'in-stock', label: 'Show: in stock' },
  { value: 'out-of-stock', label: 'Show: out of stock' },
  { value: 'needs-approval', label: 'Show: awaiting pharmacist', pharmacyOnly: true },
];
/** Lowest price of a product, or null when none is set. */
const lowestPrice = (p: Product) => {
  const prices = p.variants.map((v) => v.unitPriceMinor).filter((x): x is number => x !== null && x !== undefined).map(Number);
  return prices.length ? Math.min(...prices) : null;
};
/** Same rule as the In stock column: a listed status wins, otherwise the live count. */
const stockOf = (p: Product) =>
  p.listedAvailability === 'OUT_OF_STOCK' ? 0 : p.listedAvailability === 'IN_STOCK' ? Infinity : p.variants.reduce((n, v) => n + Math.max(0, v.availableQuantity), 0);
const shows = (p: Product, show: ShowKey) => {
  switch (show) {
    case 'priced': return lowestPrice(p) !== null;
    case 'unpriced': return lowestPrice(p) === null;
    case 'photo': return p.images.length > 0;
    case 'no-photo': return p.images.length === 0;
    case 'in-stock': return stockOf(p) > 0;
    case 'out-of-stock': return stockOf(p) === 0;
    case 'needs-approval': return p.prescriptionStatus !== null && !p.pharmacistApprovedAt;
    default: return true;
  }
};

/** A column heading that sorts the list when clicked, and again the other way. */
function SortHead({ label, up, down, sort, setSort, num }: { label: string; up: SortKey; down: SortKey; sort: SortKey; setSort: (s: SortKey) => void; num?: boolean }) {
  const on = sort === up ? '↑' : sort === down ? '↓' : '';
  return (
    <th className={num ? 'num' : undefined} aria-sort={sort === up ? 'ascending' : sort === down ? 'descending' : 'none'}>
      <button className="sort-head" onClick={() => setSort(sort === up ? down : up)} title={`Sort by ${label.toLowerCase()}`}>
        {label} <span aria-hidden="true">{on || '↕'}</span>
      </button>
    </th>
  );
}

/** Lets a manager hide this shop's out-of-stock items from customers, or show them again. */
function OutOfStockSwitch({ division }: { division: string }) {
  const shop = useLoad(() => get<{ hideOutOfStock: boolean }>(`/divisions/${division}`), [division]);
  const { run, busy } = useAction();
  const hide = !!shop.data?.hideOutOfStock;
  const toggle = () =>
    run(async () => {
      await patch(`/admin/catalog/divisions/${division}/display`, { hideOutOfStock: !hide });
      await shop.reload();
    }, hide ? 'Out-of-stock items are showing to customers again' : 'Out-of-stock items are now hidden from customers');
  if (!shop.data) return null;
  return (
    <label className="check stock-switch" title="Customers can still open an out-of-stock item from a saved link, marked out of stock.">
      <input type="checkbox" checked={hide} disabled={busy} onChange={() => void toggle()} />
      Hide out-of-stock items from customers
    </label>
  );
}

export function ProductsPage({ division, title }: { division: string; title: string }) {
  const [tab, setTab] = useState<StatusTab>('ACTIVE');
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<SortKey>('category');
  const [show, setShow] = useState<ShowKey>('all');
  const [editing, setEditing] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const [photosFor, setPhotosFor] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [priceList, setPriceList] = useState(false);
  const [reviewing, setReviewing] = useState<Product | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkReview, setBulkReview] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const { can } = useAccess();
  const canApprove = can({ any: ['pharmacy:approve'], division });
  const { run } = useAction();
  const { ask, dialog } = useConfirm();

  const products = useLoad(
    () => getAll<Product>(`/admin/catalog/products?division=${division}${tab !== 'ALL' ? `&status=${tab}` : ''}`),
    [division, tab],
  );
  const categories = useLoad(() => get<Category[]>(`/catalog/categories?division=${division}`), [division]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const order = new Map((categories.data ?? []).map((c, i) => [c.id, i]));
    return (products.data ?? [])
      .filter(
        (p) =>
          shows(p, show) &&
          (!category || p.category?.id === category) &&
          (!term || p.name.toLowerCase().includes(term) || (p.brand ?? '').toLowerCase().includes(term) || p.variants.some((v) => v.sku.toLowerCase().includes(term))),
      )
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        // Products with no price always go to the end, whichever way prices are sorted.
        const price = (dir: number) => {
          const pa = lowestPrice(a), pb = lowestPrice(b);
          if (pa === null || pb === null) return pa === pb ? byName : pa === null ? 1 : -1;
          return (pa - pb) * dir || byName;
        };
        switch (sort) {
          case 'name': return byName;
          case 'name-desc': return -byName;
          case 'price': return price(1);
          case 'price-desc': return price(-1);
          case 'stock': return stockOf(b) - stockOf(a) || byName;
          case 'newest': return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || byName;
          default: return (order.get(a.category?.id ?? '') ?? 99) - (order.get(b.category?.id ?? '') ?? 99) || byName;
        }
      });
  }, [products.data, categories.data, q, category, sort, show]);

  // Selection follows the list on screen, so a filter or new tab starts clean.
  useEffect(() => setSelected(new Set()), [division, tab, q, category, show]);
  const allOn = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(rows.map((p) => p.id)));

  const runBulk = (action: string, prescriptionStatus?: Prescription) =>
    run(async () => {
      const ids = [...selected];
      const result: BulkResult = { updated: 0, skipped: [] };
      for (let i = 0; i < ids.length; i += 500) {
        const r = await post<BulkResult>('/admin/catalog/products/bulk', { ids: ids.slice(i, i + 500), action, prescriptionStatus });
        result.updated += r.updated;
        result.skipped.push(...r.skipped);
      }
      setBulkResult(result);
      setSelected(new Set());
      await products.reload();
    });
  const confirmBulk = (message: string, action: string, label: string) => ask(message, () => void runBulk(action), label);
  const count = selected.size;
  const items = `${count} product${count === 1 ? '' : 's'}`;

  const savePrice = (v: Variant, kobo: number) =>
    run(async () => {
      await patch(`/admin/catalog/variants/${v.id}`, { unitPriceMinor: kobo });
      await products.reload();
    }, `Price updated to ${formatNaira(kobo)}`);

  const setStatus = (p: Product, status: Product['status']) =>
    run(async () => {
      await patch(`/admin/catalog/products/${p.id}`, { status });
      await products.reload();
    }, status === 'ARCHIVED' ? `${p.name} removed from sale` : `${p.name} is now ${status.toLowerCase()}`);

  return (
    <>
      <PageHead
        title={title}
        subtitle={<>Click a price to change it. Customers see only products that are on sale and <Link to="/data-check">confirmed</Link>.</>}
        actions={<><OutOfStockSwitch division={division} /><button className="btn" onClick={() => setPriceList(true)}>Upload price list</button><button className="btn" onClick={() => setBulk(true)}>Upload photos in bulk</button><button className="btn primary" onClick={() => setAdding(true)}>+ Add product</button></>}
      />
      <div className="toolbar">
        <Tabs<StatusTab>
          value={tab}
          onChange={setTab}
          options={[{ value: 'ACTIVE', label: 'On sale' }, { value: 'DRAFT', label: 'Drafts' }, { value: 'ARCHIVED', label: 'Archived' }, { value: 'ALL', label: 'All' }]}
        />
        <input className="search" placeholder="Search name, brand or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={{ width: 'auto' }} value={show} onChange={(e) => setShow(e.target.value as ShowKey)} aria-label="Show">
          {SHOWS.filter((o) => !o.pharmacyOnly || division === 'pharmacy-laboratory').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="muted small">{rows.length} products</span>
      </div>
      {count > 0 && (
        <div className="bulk-bar" role="region" aria-label="Actions for selected products">
          <strong>{count} selected</strong>
          <button className="btn sm primary" onClick={() => confirmBulk(`Show ${items} to customers? Each will be confirmed and put on sale. They can only be bought once they also have a price and stock.`, 'PUBLISH', 'Show to customers')}>Show to customers</button>
          <button className="btn sm" onClick={() => void runBulk('UNPUBLISH')}>Hide from customers</button>
          <button className="btn sm" onClick={() => void runBulk('ALLOW_PURCHASE')}>Allow purchase</button>
          <button className="btn sm" onClick={() => void runBulk('BLOCK_PURCHASE')}>Block purchase</button>
          <button className="btn sm" onClick={() => void runBulk('MARK_IN_STOCK')}>Mark in stock</button>
          <button className="btn sm" onClick={() => void runBulk('MARK_OUT_OF_STOCK')}>Mark out of stock</button>
          <button className="btn sm" onClick={() => void runBulk('USE_LIVE_COUNT')}>Use live count</button>
          {canApprove && <button className="btn sm" onClick={() => setBulkReview(true)}>Pharmacist approve</button>}
          {tab === 'ARCHIVED'
            ? <button className="btn sm" onClick={() => void runBulk('RESTORE')}>Restore</button>
            : <button className="btn sm danger" onClick={() => confirmBulk(`Remove ${items} from sale? You can restore them from the Archived tab.`, 'ARCHIVE', 'Remove from sale')}>Remove from sale</button>}
          <button className="btn sm link" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      <Loading error={products.error} loading={products.loading && !products.data} />
      {products.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}><input type="checkbox" className="row-check" aria-label="Select all products shown" title="Select all" checked={allOn} onChange={toggleAll} /></th>
                <th style={{ width: 52 }}></th>
                <SortHead label="Product" up="name" down="name-desc" sort={sort} setSort={setSort} />
                <th>Size / pack</th>
                <SortHead label="Price" up="price" down="price-desc" sort={sort} setSort={setSort} num />
                <SortHead label="In stock" up="stock" down="stock" sort={sort} setSort={setSort} num />
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="empty">No products here.</td></tr>}
              {rows.map((p) =>
                (p.variants.length ? p.variants : [null]).map((v, i) => (
                  <tr key={`${p.id}-${v?.id ?? 'none'}`}>
                    {i === 0 && (
                      <>
                        <td rowSpan={Math.max(1, p.variants.length)}><input type="checkbox" className="row-check" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          <button className="thumb-btn" title="Manage photos" aria-label={`Manage photos of ${p.name}`} onClick={() => setPhotosFor(p.id)}>
                            {p.images[0] ? <img className="thumb" src={p.images[0].url} alt="" /> : <div className="thumb thumb-pending">Image pending</div>}
                          </button>
                        </td>
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          <strong>{p.name}</strong>
                          <div className="muted small">{[p.brand, p.category?.name, p.isAgeRestricted ? '18+' : null].filter(Boolean).join(' · ')}</div>
                        </td>
                      </>
                    )}
                    <td>
                      {v ? <>{v.name}<div className="muted small mono">{v.sku}</div></> : <span className="muted">No sizes yet</span>}
                      {v && !v.isActive && <StatusPill status="INACTIVE" />}
                    </td>
                    <td className="num">{v ? <InlinePrice minor={v.unitPriceMinor} onSave={(k) => savePrice(v, k)} /> : '—'}</td>
                    <td className="num">{v ? <StockCell product={p} variant={v} /> : '—'}</td>
                    {i === 0 && (
                      <>
                        <td rowSpan={Math.max(1, p.variants.length)}><StatusPill status={p.status} />{p.verification !== 'VERIFIED' && <div style={{ marginTop: 4 }}><Pill tone="amber">{p.verification === 'DEV_SAMPLE' ? 'sample' : 'unconfirmed'}</Pill></div>}{p.prescriptionStatus && <div style={{ marginTop: 4 }}><Pill tone={p.pharmacistApprovedAt ? 'green' : 'amber'}>{p.pharmacistApprovedAt ? 'Pharmacist approved' : 'Awaiting pharmacist'}</Pill><div className="muted small">{PRESCRIPTION[p.prescriptionStatus]}</div></div>}</td>
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          <div className="row-actions">
                            <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>
                            <button className="btn sm" onClick={() => setPhotosFor(p.id)}>Photos</button>
                            {p.prescriptionStatus && canApprove && <button className="btn sm primary" onClick={() => setReviewing(p)}>Review</button>}
                            {p.status === 'ARCHIVED' ? (
                              <button className="btn sm" onClick={() => void setStatus(p, 'ACTIVE')}>Restore</button>
                            ) : (
                              <button className="btn sm danger" onClick={() => ask(`Remove "${p.name}" from sale? Customers will no longer see it. You can restore it from the Archived tab.`, () => void setStatus(p, 'ARCHIVED'), 'Remove from sale')}>Remove</button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      {dialog}
      {bulkReview && <BulkPharmacyReview count={count} onClose={() => setBulkReview(false)} onApprove={(status) => { setBulkReview(false); void runBulk('PHARMACY_APPROVE', status); }} />}
      {bulkResult && <BulkResultDialog result={bulkResult} onClose={() => setBulkResult(null)} />}
      {reviewing && <PharmacyReview product={reviewing} onClose={() => setReviewing(null)} onSaved={() => { setReviewing(null); void products.reload(); }} />}
      {photosFor && <PhotoManager owner="product" id={photosFor} onClose={() => setPhotosFor(null)} onChanged={() => void products.reload()} />}
      {bulk && <BulkPhotoUpload onClose={() => setBulk(false)} onChanged={() => void products.reload()} />}
      {priceList && <PriceListUpload division={division} title={title} onClose={() => setPriceList(false)} onChanged={() => void products.reload()} />}
      {adding && (
        <ProductForm division={division} categories={categories.data ?? []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void products.reload(); }} />
      )}
      {editing && (
        <ProductForm
          division={division}
          categories={categories.data ?? []}
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void products.reload(); }}
        />
      )}
    </>
  );
}

interface BulkResult {
  updated: number;
  skipped: { id: string; name: string; reason: string }[];
}

/** Says plainly what happened, including anything that could not be changed. */
function BulkResultDialog({ result, onClose }: { result: BulkResult; onClose: () => void }) {
  return (
    <Modal title="Done" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <p style={{ marginTop: 0 }}><strong>{result.updated}</strong> product{result.updated === 1 ? '' : 's'} updated.</p>
      {result.skipped.length > 0 && (
        <>
          <p><strong>{result.skipped.length}</strong> could not be changed:</p>
          <ul className="small" style={{ maxHeight: 260, overflow: 'auto', paddingLeft: 18 }}>
            {result.skipped.map((s) => <li key={s.id}><strong>{s.name}</strong>: {s.reason}</li>)}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** Approving many at once suits simple groups. The same legal check applies to every item. */
function BulkPharmacyReview({ count, onClose, onApprove }: { count: number; onClose: () => void; onApprove: (status: Prescription) => void }) {
  const [status, setStatus] = useState<Prescription>('NOT_REVIEWED');
  const [checked, setChecked] = useState(false);
  return (
    <Modal title={`Approve ${count} product${count === 1 ? '' : 's'}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={status === 'NOT_REVIEWED' || !checked} onClick={() => onApprove(status)}>Approve all</button></>}>
      <div className="form-grid">
        <Field label="Prescription status for all of them" hint="Use this only when it is the same for every selected product" full>
          <select value={status} onChange={(e) => setStatus(e.target.value as Prescription)}>
            {(Object.keys(PRESCRIPTION) as Prescription[]).map((k) => <option key={k} value={k}>{PRESCRIPTION[k]}</option>)}
          </select>
        </Field>
        <Field label="Your check" full>
          <label className="check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked the name, description and photo of every selected product against the actual product</label>
        </Field>
      </div>
    </Modal>
  );
}

/** The pharmacist's decision. Nothing reaches customers without it. */
function PharmacyReview({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [status, setStatus] = useState<Prescription>(product.prescriptionStatus ?? 'NOT_REVIEWED');
  const [description, setDescription] = useState(product.description ?? '');
  const [approved, setApproved] = useState(!!product.pharmacistApprovedAt);
  const [canBuy, setCanBuy] = useState(product.purchaseEnabled);
  const needsPrescription = status === 'REQUIRED' || status === 'RESTRICTED';
  const save = () =>
    run(() => post(`/admin/catalog/products/${product.id}/pharmacy-review`, { prescriptionStatus: status, approved, description: description.trim() || undefined, purchaseEnabled: approved && canBuy && !needsPrescription }), approved ? 'Approved' : 'Saved').then((ok) => ok && onSaved());
  return (
    <Modal
      title={`Pharmacist review: ${product.name}`}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (approved && status === 'NOT_REVIEWED')} onClick={() => void save()}>Save review</button></>}
    >
      {product.verificationNote && <div className="banner warn">To check: {product.verificationNote}</div>}
      <div className="form-grid">
        <Field label="Description" hint="This is a draft until you approve it. Do not add dosage advice." full><textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Prescription status" full>
          <select value={status} onChange={(e) => setStatus(e.target.value as Prescription)}>
            {(Object.keys(PRESCRIPTION) as Prescription[]).map((k) => <option key={k} value={k}>{PRESCRIPTION[k]}</option>)}
          </select>
        </Field>
        <Field label="Approval" full>
          <label className="check"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> I have checked the name, description and photo against the actual product</label>
        </Field>
        <Field label="Purchase" hint={needsPrescription ? 'Prescription and restricted medicines cannot be bought online. Customers are asked to book a pharmacist.' : 'A price, a live stock count and company confirmation are also needed.'} full>
          <label className="check"><input type="checkbox" disabled={!approved || needsPrescription} checked={canBuy && approved && !needsPrescription} onChange={(e) => setCanBuy(e.target.checked)} /> I have verified current availability, so this may be bought</label>
        </Field>
      </div>
    </Modal>
  );
}

function ProductForm({
  division,
  categories,
  product,
  onClose,
  onSaved,
}: {
  division: string;
  categories: Category[];
  product?: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run, busy } = useAction();
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [categoryId, setCategoryId] = useState(product?.category?.id ?? categories[0]?.id ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [ageRestricted, setAgeRestricted] = useState(product?.isAgeRestricted ?? false);
  const [status, setStatus] = useState<Product['status']>(product?.status ?? 'ACTIVE');
  const [imageUrl, setImageUrl] = useState('');
  const [listed, setListed] = useState<string>(product?.listedAvailability ?? '');
  const [canBuy, setCanBuy] = useState(product?.purchaseEnabled ?? true);
  const isPharmacy = !!product?.prescriptionStatus;
  // New product: first size. Existing product: editable list of sizes.
  const [variants, setVariants] = useState(
    product?.variants.map((v) => ({ id: v.id, sku: v.sku, name: v.name, price: v.unitPriceMinor as number | null, isActive: v.isActive })) ?? [
      { id: '', sku: '', name: '', price: null as number | null, isActive: true },
    ],
  );

  const update = (i: number, patchV: Partial<(typeof variants)[number]>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patchV } : v)));
  const valid = name.trim().length >= 2 && variants.every((v) => v.name.trim() && (v.id || /^[A-Z0-9][A-Z0-9-]{1,47}$/.test(v.sku)));

  const save = () =>
    run(async () => {
      const base = {
        name: name.trim(),
        brand: brand.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        isAgeRestricted: ageRestricted,
        listedAvailability: listed ? (listed as Product['listedAvailability']) : null,
        ...(isPharmacy ? {} : { purchaseEnabled: canBuy }),
      };
      if (!product) {
        await post('/admin/catalog/products', {
          ...base,
          division,
          slug: `${slugify(name)}-${Date.now().toString(36)}`,
          status,
          variants: variants.map((v) => ({ sku: v.sku, name: v.name.trim(), unitPriceMinor: v.price })),
          images: imageUrl.trim() ? [{ url: imageUrl.trim(), altText: name.trim() }] : undefined,
        });
        return;
      }
      for (const v of variants) {
        if (v.id) {
          const before = product.variants.find((x) => x.id === v.id)!;
          if (before.name !== v.name || before.unitPriceMinor !== v.price || before.isActive !== v.isActive) {
            await patch(`/admin/catalog/variants/${v.id}`, { name: v.name.trim(), unitPriceMinor: v.price, isActive: v.isActive });
          }
        } else {
          await post(`/admin/catalog/products/${product.id}/variants`, { sku: v.sku, name: v.name.trim(), unitPriceMinor: v.price });
        }
      }
      if (imageUrl.trim()) await post(`/admin/catalog/products/${product.id}/images`, { url: imageUrl.trim(), altText: name.trim() });
      await patch(`/admin/catalog/products/${product.id}`, { ...base, status });
    }, product ? 'Product saved' : 'Product added').then((ok) => ok && onSaved());

  return (
    <Modal
      title={product ? `Edit ${product.name}` : 'Add product'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Product name" full>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Venida Table Water 75cl" />
        </Field>
        <Field label="Brand">
          <input value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">— None —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Description" full>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Visibility">
          <select value={status} onChange={(e) => setStatus(e.target.value as Product['status'])}>
            <option value="ACTIVE">On sale</option>
            <option value="DRAFT">Draft (hidden)</option>
            <option value="ARCHIVED">Archived (removed)</option>
          </select>
        </Field>
        <Field label="Age restriction">
          <label className="check"><input type="checkbox" checked={ageRestricted} onChange={(e) => setAgeRestricted(e.target.checked)} /> Alcoholic — 18+ only</label>
        </Field>
        <Field label="Availability" hint="In stock: customers can always order it. Out of stock: they cannot. Use the stock count: only while the counted number allows.">
          <select value={listed} onChange={(e) => setListed(e.target.value)}>
            <option value="IN_STOCK">In stock (always available)</option>
            <option value="OUT_OF_STOCK">Out of stock</option>
            <option value="">Use the stock count</option>
          </select>
        </Field>
        {!isPharmacy && (
          <Field label="Purchase" hint="Also needs a price, stock and company confirmation">
            <label className="check"><input type="checkbox" checked={canBuy} onChange={(e) => setCanBuy(e.target.checked)} /> Availability confirmed, so this may be bought</label>
          </Field>
        )}
        {isPharmacy && <div className="banner warn field full" style={{ margin: 0 }}>Changing the name or description removes pharmacist approval, unless you are the pharmacist.</div>}
        <Field label="Add a photo (optional)" hint="An https:// link, or a /media/… path" full>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </Field>
      </div>

      <div>
        <h3 style={{ marginBottom: 8 }}>Sizes &amp; prices</h3>
        <table>
          <thead>
            <tr><th>Size / pack</th><th>SKU</th><th className="num">Price (₦), blank if not published</th>{product && <th>For sale</th>}</tr>
          </thead>
          <tbody>
            {variants.map((v, i) => (
              <tr key={i}>
                <td><input value={v.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="e.g. Pack of 12 (75cl)" /></td>
                <td>
                  {v.id ? <span className="mono">{v.sku}</span> : (
                    <input value={v.sku} onChange={(e) => update(i, { sku: e.target.value.toUpperCase() })} placeholder="NMP-WTR-010" />
                  )}
                </td>
                <td style={{ width: 150 }}><MoneyInput value={v.price} onChange={(p) => update(i, { price: p })} /></td>
                {product && (
                  <td>{v.id ? <input type="checkbox" style={{ width: 'auto' }} checked={v.isActive} onChange={(e) => update(i, { isActive: e.target.checked })} /> : 'new'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setVariants((vs) => [...vs, { id: '', sku: '', name: '', price: null, isActive: true }])}>
          + Add another size
        </button>
        {!product && <p className="muted small">New products start with 0 in stock. Add stock on the Stock page.</p>}
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { get, patch, post } from '../api';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira, slugify } from '../money';

interface Variant {
  id: string;
  sku: string;
  name: string;
  unitPriceMinor: number;
  isActive: boolean;
  availableQuantity: number;
  minOrderQty: number;
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
  category: { id: string; name: string } | null;
  images: { id: string; url: string }[];
  variants: Variant[];
}
interface Category {
  id: string;
  name: string;
}

type StatusTab = 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'ALL';

export function ProductsPage({ division, title }: { division: string; title: string }) {
  const [tab, setTab] = useState<StatusTab>('ACTIVE');
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const { run } = useAction();
  const { ask, dialog } = useConfirm();

  const products = useLoad(
    () => get<{ data: Product[] }>(`/admin/catalog/products?division=${division}&pageSize=100${tab !== 'ALL' ? `&status=${tab}` : ''}`).then((r) => r.data),
    [division, tab],
  );
  const categories = useLoad(() => get<Category[]>(`/catalog/categories?division=${division}`), [division]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const order = new Map((categories.data ?? []).map((c, i) => [c.id, i]));
    return (products.data ?? [])
      .filter(
        (p) =>
          (!category || p.category?.id === category) &&
          (!term || p.name.toLowerCase().includes(term) || (p.brand ?? '').toLowerCase().includes(term) || p.variants.some((v) => v.sku.toLowerCase().includes(term))),
      )
      .sort((a, b) => (order.get(a.category?.id ?? '') ?? 99) - (order.get(b.category?.id ?? '') ?? 99) || a.name.localeCompare(b.name));
  }, [products.data, categories.data, q, category]);

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
        actions={<button className="btn primary" onClick={() => setAdding(true)}>+ Add product</button>}
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
        <span className="muted small">{rows.length} products</span>
      </div>
      <Loading error={products.error} loading={products.loading && !products.data} />
      {products.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 52 }}></th>
                <th>Product</th>
                <th>Category</th>
                <th>Size / pack</th>
                <th className="num">Price</th>
                <th className="num">In stock</th>
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
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          {p.images[0] ? <img className="thumb" src={p.images[0].url} alt="" /> : <div className="thumb" />}
                        </td>
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          <strong>{p.name}</strong>
                          <div className="muted small">{p.brand}{p.isAgeRestricted ? ' · 18+' : ''}</div>
                        </td>
                        <td rowSpan={Math.max(1, p.variants.length)}>{p.category?.name ?? <span className="muted">—</span>}</td>
                      </>
                    )}
                    <td>
                      {v ? <>{v.name}<div className="muted small mono">{v.sku}</div></> : <span className="muted">No sizes yet</span>}
                      {v && !v.isActive && <StatusPill status="INACTIVE" />}
                    </td>
                    <td className="num">{v ? <InlinePrice minor={v.unitPriceMinor} onSave={(k) => savePrice(v, k)} /> : '—'}</td>
                    <td className="num">{v ? (v.availableQuantity > 0 ? v.availableQuantity : <span className="pill red">Out of stock</span>) : '—'}</td>
                    {i === 0 && (
                      <>
                        <td rowSpan={Math.max(1, p.variants.length)}><StatusPill status={p.status} />{p.verification !== 'VERIFIED' && <div style={{ marginTop: 4 }}><Pill tone="amber">{p.verification === 'DEV_SAMPLE' ? 'sample' : 'unconfirmed'}</Pill></div>}</td>
                        <td rowSpan={Math.max(1, p.variants.length)}>
                          <div className="row-actions">
                            <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>
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
  // New product: first size. Existing product: editable list of sizes.
  const [variants, setVariants] = useState(
    product?.variants.map((v) => ({ id: v.id, sku: v.sku, name: v.name, price: v.unitPriceMinor as number | null, isActive: v.isActive })) ?? [
      { id: '', sku: '', name: '', price: null as number | null, isActive: true },
    ],
  );

  const update = (i: number, patchV: Partial<(typeof variants)[number]>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patchV } : v)));
  const valid = name.trim().length >= 2 && variants.every((v) => v.name.trim() && v.price !== null && (v.id || /^[A-Z0-9][A-Z0-9-]{1,47}$/.test(v.sku)));

  const save = () =>
    run(async () => {
      const base = {
        name: name.trim(),
        brand: brand.trim() || undefined,
        categoryId: categoryId || undefined,
        description: description.trim() || undefined,
        isAgeRestricted: ageRestricted,
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
        <Field label="Add a photo (optional)" hint="An https:// link, or a /media/… path" full>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </Field>
      </div>

      <div>
        <h3 style={{ marginBottom: 8 }}>Sizes &amp; prices</h3>
        <table>
          <thead>
            <tr><th>Size / pack</th><th>SKU</th><th className="num">Price (₦)</th>{product && <th>For sale</th>}</tr>
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

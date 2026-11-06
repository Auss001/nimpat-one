import { useMemo, useState } from 'react';
import { get, post } from '../api';
import { Loading, PageHead, Pill, Tabs, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira } from '../money';

type RecordType = 'PRODUCT' | 'APARTMENT_UNIT' | 'VEHICLE' | 'SPA_TREATMENT' | 'SERVICE_OFFERING' | 'DELIVERY_ZONE';
interface Row { id: string; name: string; detail: string; priceMinor: number | null; verification: string }

async function loadRows(type: RecordType): Promise<Row[]> {
  const r = (id: string, name: string, detail: string, priceMinor: number | null, verification: string): Row => ({ id, name, detail, priceMinor, verification });
  switch (type) {
    case 'PRODUCT': {
      const [d, t] = await Promise.all([
        get('/admin/catalog/products?division=water-drinks-wines&pageSize=100'),
        get('/admin/catalog/products?division=retail-general-supplies&pageSize=100'),
      ]);
      return [...d.data, ...t.data].filter((p: any) => p.status !== 'ARCHIVED').map((p: any) => r(p.id, p.name, p.category?.name ?? '', p.variants[0]?.unitPriceMinor ?? null, p.verification));
    }
    case 'APARTMENT_UNIT':
      return (await get<any[]>('/admin/apartments/properties')).flatMap((p) => p.units.map((u: any) => r(u.id, u.name, `${p.name} · ${p.city}`, u.nightlyRateMinor, u.verification)));
    case 'VEHICLE':
      return (await get('/admin/vehicles?pageSize=100')).data.map((v: any) => r(v.id, `${v.year} ${v.make} ${v.model}`, v.status, v.priceMinor, v.verification));
    case 'SPA_TREATMENT':
      return (await get<any[]>('/admin/spa/treatments')).map((t) => r(t.id, t.name, `${t.category ?? ''} · ${t.durationMinutes} min`, t.priceMinor, t.verification));
    case 'SERVICE_OFFERING':
      return (await get<any[]>('/admin/services')).map((s) => r(s.id, s.name, s.division.name, s.basePriceMinor, s.verification));
    case 'DELIVERY_ZONE':
      return (await get<any[]>('/admin/delivery/zones?division=water-drinks-wines')).map((z) => r(z.id, z.name, z.cities.length ? z.cities.join(', ') : `All of ${z.state}`, z.feeMinor, z.verification));
  }
}

const TONE: Record<string, 'green' | 'amber' | 'red'> = { VERIFIED: 'green', AWAITING_CONFIRMATION: 'amber', DEV_SAMPLE: 'red' };
const LABEL: Record<string, string> = { VERIFIED: 'Confirmed', AWAITING_CONFIRMATION: 'Awaiting confirmation', DEV_SAMPLE: 'Development sample' };

export function DataCheckPage() {
  const [type, setType] = useState<RecordType>('PRODUCT');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const audit = useLoad(() => get<any>('/admin/records/audit'));
  const rows = useLoad(() => loadRows(type), [type]);
  const { run, busy } = useAction();
  const { ask, dialog } = useConfirm();

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (rows.data ?? []).filter((r) => !term || r.name.toLowerCase().includes(term));
  }, [rows.data, q]);
  const selectable = visible.filter((r) => r.verification !== 'DEV_SAMPLE');
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  const changeType = (t: RecordType) => { setType(t); setSelected(new Set()); };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = (verification: 'VERIFIED' | 'AWAITING_CONFIRMATION') =>
    run(async () => {
      const ids = [...selected];
      for (let i = 0; i < ids.length; i += 200) await post('/admin/records/verification', { type, ids: ids.slice(i, i + 200), verification });
      setSelected(new Set());
      await Promise.all([rows.reload(), audit.reload()]);
    }, verification === 'VERIFIED' ? 'Records confirmed' : 'Confirmation removed');

  const m = audit.data?.missing;
  const c = audit.data?.verificationCounts;
  const COUNT_KEY: Record<RecordType, string> = { PRODUCT: 'products', APARTMENT_UNIT: 'apartmentUnits', VEHICLE: 'vehicles', SPA_TREATMENT: 'spaTreatments', SERVICE_OFFERING: 'serviceOfferings', DELIVERY_ZONE: 'deliveryZones' };
  const TAB_LABEL: Record<RecordType, string> = { PRODUCT: 'Products', APARTMENT_UNIT: 'Apartments', VEHICLE: 'Vehicles', SPA_TREATMENT: 'Spa', SERVICE_OFFERING: 'Listings', DELIVERY_ZONE: 'Delivery zones' };

  return (
    <>
      <PageHead title="Data confirmation" subtitle="Customers can only buy or book records the company has confirmed. Check prices and details, then confirm." />
      <Loading error={audit.error} loading={audit.loading && !audit.data} />
      {m && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Missing title="Products without stock" items={m.inventoryQuantities} />
          <Missing title="Products without photos" items={m.productPhotos} />
          <Missing title="Products without prices" items={m.productPrices} />
          <Missing title="Apartments without photos" items={m.apartmentPhotos} />
          <Missing title="Vehicles without a deposit" items={m.vehicleDeposits} />
          <Missing title="Treatments without a therapist" items={m.spaTreatmentsWithoutTherapist} />
          <Missing title="Delivery fees to confirm" items={m.deliveryFees} />
          <div className="card stat">
            <div className="label">Payment setup</div>
            <div className="small" style={{ marginTop: 6 }}>{m.receivingBankAccounts}<br />{m.serviceLocations}</div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <Tabs<RecordType>
          value={type}
          onChange={changeType}
          options={(Object.keys(TAB_LABEL) as RecordType[]).map((t) => ({ value: t, label: `${TAB_LABEL[t]}${c ? ` (${c[COUNT_KEY[t]].AWAITING_CONFIRMATION})` : ''}` }))}
        />
      </div>
      <div className="toolbar">
        <input className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ flex: 1 }} className="muted small">{selected.size} selected</span>
        <button className="btn" disabled={!selected.size || busy} onClick={() => void apply('AWAITING_CONFIRMATION')}>Remove confirmation</button>
        <button className="btn primary" disabled={!selected.size || busy} onClick={() => ask(`Confirm ${selected.size} record(s)? Once they are active and in stock, customers can buy or book them at the prices shown.`, () => void apply('VERIFIED'), 'Confirm records')}>Confirm selected</button>
      </div>
      {dialog}
      <Loading error={rows.error} loading={rows.loading && !rows.data} />
      {rows.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" style={{ width: 'auto' }} aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(selectable.map((r) => r.id)))} /></th>
                <th>Record</th><th>Details</th><th className="num">Price</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && <tr><td colSpan={5} className="empty">Nothing here.</td></tr>}
              {visible.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" style={{ width: 'auto' }} aria-label={`Select ${r.name}`} disabled={r.verification === 'DEV_SAMPLE'} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td><strong>{r.name}</strong></td>
                  <td className="small muted">{r.detail}</td>
                  <td className="num">{r.priceMinor != null ? formatNaira(r.priceMinor) : '—'}</td>
                  <td><Pill tone={TONE[r.verification]}>{LABEL[r.verification]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Missing({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="card stat">
      <div className="label">{title}</div>
      <div className="value" style={items.length ? { color: 'var(--brand)' } : undefined}>{items.length}</div>
      {items.length > 0 && <div className="small muted" style={{ marginTop: 2 }} title={items.join(', ')}>{items.slice(0, 2).join(', ')}{items.length > 2 ? '…' : ''}</div>}
    </div>
  );
}

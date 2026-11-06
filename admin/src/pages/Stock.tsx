import { useMemo, useState } from 'react';
import { get, patch, post } from '../api';
import { Field, Loading, Modal, PageHead, Pill, Tabs, useAction, useLoad } from '../components/ui';

interface Level {
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number;
  available: number;
  lowStock: boolean;
  location: { id: string; code: string; name: string };
  variant: { id: string; sku: string; name: string; product: { id: string; name: string } };
}

type Division = 'water-drinks-wines' | 'retail-general-supplies';
type Mode = 'receive' | 'count' | 'reorder';

export function StockPage() {
  const [division, setDivision] = useState<Division>('water-drinks-wines');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [action, setAction] = useState<{ level: Level; mode: Mode } | null>(null);
  const levels = useLoad(() => get<{ data: Level[] }>(`/admin/inventory?division=${division}&pageSize=100`).then((r) => r.data), [division]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (levels.data ?? [])
      .filter((l) => !term || l.variant.product.name.toLowerCase().includes(term) || l.variant.sku.toLowerCase().includes(term))
      .filter((l) => (filter === 'low' ? l.lowStock : filter === 'out' ? l.available <= 0 : true))
      .sort((a, b) => a.variant.product.name.localeCompare(b.variant.product.name));
  }, [levels.data, q, filter]);

  const outCount = (levels.data ?? []).filter((l) => l.available <= 0).length;

  return (
    <>
      <PageHead
        title="Stock"
        subtitle="Receive deliveries, correct counts after a stock-take, and set low-stock alerts. Every change is recorded."
      />
      {outCount > 0 && (
        <div className="banner warn">
          {outCount} item{outCount === 1 ? ' is' : 's are'} out of stock and cannot be ordered. Use <strong>Receive</strong> to add opening stock.
        </div>
      )}
      <div className="toolbar">
        <Tabs<Division>
          value={division}
          onChange={setDivision}
          options={[{ value: 'water-drinks-wines', label: 'Water, Drinks & Wines' }, { value: 'retail-general-supplies', label: 'Retail & Supplies' }]}
        />
        <Tabs<'all' | 'low' | 'out'>
          value={filter}
          onChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }]}
        />
        <input className="search" placeholder="Search product or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Loading error={levels.error} loading={levels.loading && !levels.data} />
      {levels.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Size / pack</th>
                <th>Location</th>
                <th className="num">On hand</th>
                <th className="num">Reserved</th>
                <th className="num">Available</th>
                <th className="num">Alert at</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="empty">Nothing matches.</td></tr>}
              {rows.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.variant.product.name}</strong></td>
                  <td>{l.variant.name}<div className="muted small mono">{l.variant.sku}</div></td>
                  <td className="small">{l.location.name}</td>
                  <td className="num">{l.quantityOnHand}</td>
                  <td className="num muted" title="Held for unpaid orders">{l.quantityReserved}</td>
                  <td className="num">
                    {l.available <= 0 ? <Pill tone="red">0</Pill> : l.lowStock ? <Pill tone="amber">{l.available}</Pill> : l.available}
                  </td>
                  <td className="num">
                    <button className="btn link" onClick={() => setAction({ level: l, mode: 'reorder' })}>{l.reorderLevel}</button>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn sm primary" onClick={() => setAction({ level: l, mode: 'receive' })}>Receive</button>
                      <button className="btn sm" onClick={() => setAction({ level: l, mode: 'count' })}>Set count</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {action && <StockDialog {...action} onClose={() => setAction(null)} onDone={() => { setAction(null); void levels.reload(); }} />}
    </>
  );
}

function StockDialog({ level, mode, onClose, onDone }: { level: Level; mode: Mode; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [qty, setQty] = useState(mode === 'count' ? String(level.quantityOnHand) : mode === 'reorder' ? String(level.reorderLevel) : '');
  const [reason, setReason] = useState(mode === 'receive' ? 'Delivery received' : 'Stock-take correction');
  const n = Number(qty);
  const validNumber = qty.trim() !== '' && Number.isInteger(n) && n >= 0;
  const delta = mode === 'receive' ? n : n - level.quantityOnHand;
  const belowReserved = mode === 'count' && n < level.quantityReserved;
  const valid = validNumber && (mode === 'reorder' || (delta !== 0 && reason.trim().length >= 3 && !belowReserved && (mode !== 'receive' || n > 0)));

  const save = () =>
    run(async () => {
      if (mode === 'reorder') {
        await patch(`/admin/inventory/levels/${level.id}`, { reorderLevel: n });
      } else {
        await post('/admin/inventory/adjustments', {
          variantId: level.variant.id,
          locationId: level.location.id,
          delta,
          type: mode === 'receive' ? 'RECEIPT' : 'ADJUSTMENT',
          reason: reason.trim(),
        });
      }
    }, mode === 'reorder' ? 'Alert level saved' : 'Stock updated').then((ok) => ok && onDone());

  const title = { receive: 'Receive stock', count: 'Set stock count', reorder: 'Low-stock alert' }[mode];
  return (
    <Modal
      title={`${title} — ${level.variant.product.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {level.variant.name} · currently {level.quantityOnHand} on hand{level.quantityReserved ? `, ${level.quantityReserved} reserved for unpaid orders` : ''}.
      </p>
      <Field
        label={mode === 'receive' ? 'Quantity received' : mode === 'count' ? 'Counted quantity on hand' : 'Warn me when available stock falls to'}
        hint={mode === 'count' && validNumber && delta !== 0 ? `${delta > 0 ? '+' : ''}${delta} compared with the system` : undefined}
      >
        <input autoFocus inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      {belowReserved && <div className="banner error" style={{ margin: 0 }}>Cannot go below the {level.quantityReserved} units already reserved for orders.</div>}
      {mode !== 'reorder' && (
        <Field label="Reason (kept in the stock history)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

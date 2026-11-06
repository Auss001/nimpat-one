import { useState } from 'react';
import { api, get, patch } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, StatusPill, Tabs, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentOption: string;
  outstandingMinor: number;
  fulfilmentType: string;
  totalMinor: number;
  createdAt: string;
  user: { email: string; phone: string | null };
  delivery: { status: string } | null;
  _count: { items: number };
}

const NEXT: Record<string, { to: string; label: string; danger?: boolean }[]> = {
  PENDING: [{ to: 'CANCELLED', label: 'Cancel order', danger: true }],
  ACCEPTED: [{ to: 'PROCESSING', label: 'Start processing' }, { to: 'READY', label: 'Mark ready' }, { to: 'CANCELLED', label: 'Cancel & restock', danger: true }],
  PROCESSING: [{ to: 'READY', label: 'Mark ready' }, { to: 'OUT_FOR_DELIVERY', label: 'Out for delivery' }, { to: 'DELIVERED', label: 'Mark delivered / collected' }, { to: 'CANCELLED', label: 'Cancel & restock', danger: true }],
  READY: [{ to: 'OUT_FOR_DELIVERY', label: 'Out for delivery' }, { to: 'DELIVERED', label: 'Mark delivered / collected' }, { to: 'CANCELLED', label: 'Cancel & restock', danger: true }],
  OUT_FOR_DELIVERY: [{ to: 'DELIVERED', label: 'Mark delivered' }],
  DELIVERED: [{ to: 'COMPLETED', label: 'Complete' }],
};

type Filter = '' | 'ACCEPTED' | 'PROCESSING' | 'READY' | 'PENDING' | 'DELIVERED';

export function OrdersPage() {
  const [status, setStatus] = useState<Filter>('');
  const [division, setDivision] = useState('water-drinks-wines');
  const orders = useLoad(
    () => get<{ data: OrderRow[]; meta: { total: number } }>(`/admin/orders?division=${division}&pageSize=50${status ? `&status=${status}` : ''}`),
    [status, division],
  );
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHead title="Orders" subtitle="Delivery does not mark an order paid. Money counts only after Paystack or finance verifies it." />
      <div className="toolbar">
        <Tabs value={division} onChange={setDivision} options={[{ value: 'water-drinks-wines', label: 'Drinks' }, { value: 'retail-general-supplies', label: 'Retail' }]} />
        <Tabs<Filter>
          value={status}
          onChange={setStatus}
          options={[{ value: '', label: 'All' }, { value: 'ACCEPTED', label: 'To prepare' }, { value: 'PROCESSING', label: 'Processing' }, { value: 'READY', label: 'Ready' }, { value: 'PENDING', label: 'Pending' }, { value: 'DELIVERED', label: 'Delivered' }]}
        />
      </div>
      <Loading error={orders.error} loading={orders.loading && !orders.data} />
      {orders.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th className="num">Items</th><th>Fulfilment</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th><th>Payment</th><th></th></tr></thead>
            <tbody>
              {orders.data.data.length === 0 && <tr><td colSpan={10} className="empty">No orders yet.</td></tr>}
              {orders.data.data.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.orderNumber}</td>
                  <td>{o.user.email}<div className="muted small">{o.user.phone}</div></td>
                  <td className="small">{new Date(o.createdAt).toLocaleString('en-NG')}</td>
                  <td className="num">{o._count.items}</td>
                  <td className="small">{o.fulfilmentType === 'DELIVERY' ? `Delivery${o.delivery ? ` (${o.delivery.status.toLowerCase()})` : ''}` : 'Pickup'}</td>
                  <td className="num">{formatNaira(o.totalMinor)}</td>
                  <td className="num">{formatNaira(o.outstandingMinor)}</td>
                  <td><StatusPill status={o.status} /></td>
                  <td><StatusPill status={o.paymentStatus} /><div className="muted small">{o.paymentOption.replace(/_/g, ' ').toLowerCase()}</div></td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setOpen(o.id)}>Open</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} onChanged={() => void orders.reload()} />}
    </>
  );
}

function OrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const order = useLoad(() => get<any>(`/admin/orders/${id}`), [id]);
  const { run, busy } = useAction();
  const { ask, dialog } = useConfirm();
  const [collecting, setCollecting] = useState(false);
  const o = order.data;
  const move = (to: string, label: string) =>
    run(async () => {
      await patch(`/admin/orders/${id}/status`, { status: to });
      await order.reload();
      onChanged();
    }, `Order updated: ${label.toLowerCase()}`);

  return (
    <Modal title={o ? `Order ${o.orderNumber}` : 'Order'} onClose={onClose} wide
      footer={o && [
        o.outstandingMinor > 0 && o.fulfilmentType === 'DELIVERY' && o.paymentOption === 'PAY_ON_DELIVERY' && !['CANCELLED', 'EXPIRED'].includes(o.status)
          ? <button key="collect" className="btn" onClick={() => setCollecting(true)}>Record collection</button>
          : null,
        ...(NEXT[o.status] ?? []).map((a) => (
        <button key={a.to} className={`btn ${a.danger ? 'danger' : 'primary'}`} disabled={busy}
          onClick={() => (a.danger ? ask(`${a.label}? The customer will be notified.`, () => void move(a.to, a.label), a.label) : void move(a.to, a.label))}>{a.label}</button>
      ))]}>
      {dialog}
      {collecting && o && <CollectionForm order={o} onClose={() => setCollecting(false)} onDone={() => { setCollecting(false); void order.reload(); onChanged(); }} />}
      <Loading error={order.error} loading={order.loading && !o} />
      {o && (
        <>
          <div className="toolbar" style={{ margin: 0 }}>
            <StatusPill status={o.status} />
            <StatusPill status={o.paymentStatus} />
            <span className="muted small">{o.user.email} · {o.user.phone ?? 'no phone'} · {o.fulfilmentType.toLowerCase()}</span>
          </div>
          {o.deliveryAddress && (
            <div className="card card-pad small">
              <strong>Deliver to:</strong> {o.deliveryAddress.recipientName}, {o.deliveryAddress.phone} — {o.deliveryAddress.line1}
              {o.deliveryAddress.line2 ? `, ${o.deliveryAddress.line2}` : ''}, {o.deliveryAddress.city}, {o.deliveryAddress.state}
              {o.deliveryAddress.landmark ? ` (near ${o.deliveryAddress.landmark})` : ''}
            </div>
          )}
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
            <tbody>
              {o.items.map((i: any) => (
                <tr key={i.id}><td>{i.productName}<div className="muted small">{i.variantName} · {i.sku}</div></td><td className="num">{i.quantity}</td><td className="num">{formatNaira(i.unitPriceMinor)}</td><td className="num">{formatNaira(i.lineTotalMinor)}</td></tr>
              ))}
              <tr><td colSpan={3} className="num muted">Delivery</td><td className="num">{formatNaira(o.deliveryFeeMinor)}</td></tr>
              <tr><td colSpan={3} className="num"><strong>Total</strong></td><td className="num"><strong>{formatNaira(o.totalMinor)}</strong></td></tr>
              <tr><td colSpan={3} className="num muted">Paid (verified)</td><td className="num">{formatNaira(o.amountPaidMinor)}</td></tr>
              <tr><td colSpan={3} className="num muted">Outstanding</td><td className="num">{formatNaira(o.outstandingMinor)}</td></tr>
            </tbody>
          </table>
          {o.customerNote && <div className="banner info" style={{ margin: 0 }}><strong>Customer note:</strong> {o.customerNote}</div>}
          <div>
            <h3 style={{ marginBottom: 6 }}>History</h3>
            {o.statusHistory.map((h: any, i: number) => (
              <div key={i} className="small"><span className="muted">{new Date(h.createdAt).toLocaleString('en-NG')}</span> — {h.toStatus.replace(/_/g, ' ').toLowerCase()}{h.note ? ` · ${h.note}` : ''}</div>
            ))}
          </div>
          {o.payments.length > 0 && (
            <div className="small muted">Payments: {o.payments.map((p: any) => `${p.reference} (${p.status.toLowerCase()}${p.refundStatus !== 'NONE' ? `, refund ${p.refundStatus.toLowerCase()}` : ''})`).join(', ')}</div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Delivery officer records money collected; finance verifies it later. */
function CollectionForm({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState<number | null>(order.outstandingMinor);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  // One key per opened form, so a retried save cannot record the money twice.
  const [key] = useState(() => crypto.randomUUID());
  const valid = amount !== null && amount > 0;
  const save = () =>
    run(() => api('/admin/collections', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: { purpose: 'ORDER', payableId: order.id, method, point: 'DELIVERY', amountMinor: amount, ...(reference.trim() ? { collectionReference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
    }), 'Collection recorded. It now waits for finance.').then((ok) => ok && onDone());
  return (
    <Modal title={`Record collection for ${order.orderNumber}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Record collection</button></>}>
      <p className="muted" style={{ margin: 0 }}>This creates a receipt under your name. The order shows as paid only after finance verifies the money.</p>
      <div className="form-grid">
        <Field label="Method"><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option></select></Field>
        <Field label="Amount collected (₦)"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Transfer reference (optional)" full><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Note (optional)" full><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { useAccess } from '../access';
import { contactEmail, contactPhone, get, patch, post } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira } from '../money';

type Tab = 'cars' | 'quotes' | 'logistics' | 'deliveries';
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/_/g, ' ');
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const place = (a: any) => (a ? [a.line1, a.city, a.state].filter(Boolean).join(', ') : '—');

export function RequestsPage() {
  const { can } = useAccess();
  const all: { value: Tab; label: string; permission: string }[] = [
    { value: 'cars', label: 'Car enquiries', permission: 'inquiries:manage' },
    { value: 'quotes', label: 'Quotations', permission: 'quotations:manage' },
    { value: 'logistics', label: 'Logistics', permission: 'logistics:manage' },
    { value: 'deliveries', label: 'Deliveries', permission: 'deliveries:manage' },
  ];
  const options = all.filter((o) => can({ any: [o.permission] }));
  const [tab, setTab] = useState<Tab>(options[0]?.value ?? 'cars');
  return (
    <>
      <PageHead title="Customer requests" subtitle="Everything customers have asked for that needs a person to answer." />
      <div className="toolbar"><Tabs<Tab> value={tab} onChange={setTab} options={options.map(({ value, label }) => ({ value, label }))} /></div>
      {tab === 'cars' && <CarEnquiries />}
      {tab === 'quotes' && <Quotations />}
      {tab === 'logistics' && <Logistics />}
      {tab === 'deliveries' && <Deliveries />}
    </>
  );
}

function CarEnquiries() {
  const list = useLoad(() => get<{ data: any[] }>('/admin/vehicles/inquiries/all?pageSize=100').then((r) => r.data));
  const { run } = useAction();
  const setStatus = (id: string, status: string) => run(() => patch(`/admin/vehicles/inquiries/${id}`, { status }), 'Enquiry updated').then(() => list.reload());
  return (
    <>
      <div className="banner info">To let a customer pay a deposit on a hold request, set it to Scheduled. The customer can then pay.</div>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Car</th><th>Customer</th><th>Wants</th><th>Preferred date</th><th>Received</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={6} className="empty">No car enquiries yet.</td></tr>}
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.vehicle.year} {i.vehicle.make} {i.vehicle.model}</strong></td>
                  <td>{i.contactName}<div className="muted small"><a href={`tel:${i.contactPhone}`}>{i.contactPhone}</a> · {i.contactEmail}</div></td>
                  <td>{words(i.type)}{i.message && <div className="muted small">{i.message}</div>}</td>
                  <td className="small">{when(i.preferredDate)}</td>
                  <td className="small">{when(i.createdAt)}</td>
                  <td>
                    <select aria-label="Status" value={i.status} onChange={(e) => void setStatus(i.id, e.target.value)}>
                      <option value="NEW">New</option>
                      <option value="CONTACTED">Contacted</option>
                      <option value="SCHEDULED">Scheduled</option>
                      <option value="CLOSED_WON">Closed: sold</option>
                      <option value="CLOSED_LOST">Closed: not sold</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Quotations() {
  const list = useLoad(() => get<{ data: any[] }>('/admin/quotations?pageSize=100').then((r) => r.data));
  const [open, setOpen] = useState<any>(null);
  return (
    <>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Quote</th><th>Customer</th><th>Request</th><th className="num">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={6} className="empty">No quotation requests yet.</td></tr>}
              {list.data.map((q) => (
                <tr key={q.id}>
                  <td className="mono small">{q.quoteNumber}</td>
                  <td>{contactEmail(q.user)}<div className="muted small">{contactPhone(q.user)}</div></td>
                  <td><strong>{q.subject}</strong><div className="muted small">{q.requestDetails}</div></td>
                  <td className="num">{q.totalMinor != null ? formatNaira(q.totalMinor) : '—'}</td>
                  <td><StatusPill status={q.status} /></td>
                  <td>{['REQUESTED', 'UNDER_REVIEW', 'SENT'].includes(q.status) && <button className="btn sm primary" onClick={() => setOpen(q)}>{q.status === 'SENT' ? 'Revise' : 'Price and send'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <SendQuote quote={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void list.reload(); }} />}
    </>
  );
}

function SendQuote({ quote, onClose, onDone }: { quote: any; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [items, setItems] = useState<{ description: string; quantity: number; unitPriceMinor: number | null }[]>(
    quote.items?.length ? quote.items.map((i: any) => ({ description: i.description, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })) : [{ description: '', quantity: 1, unitPriceMinor: null }],
  );
  const [validUntil, setValidUntil] = useState('');
  const update = (n: number, change: object) => setItems((xs) => xs.map((x, i) => (i === n ? { ...x, ...change } : x)));
  const total = items.reduce((sum, i) => sum + (i.unitPriceMinor ?? 0) * i.quantity, 0);
  const valid = !!validUntil && total > 0 && items.every((i) => i.description.trim() && i.quantity > 0 && i.unitPriceMinor !== null);
  const send = () =>
    run(
      () => post(`/admin/quotations/${quote.id}/send`, { items: items.map((i) => ({ ...i, description: i.description.trim() })), validUntil: new Date(`${validUntil}T23:59:00+01:00`).toISOString() }),
      'Quotation sent',
    ).then((ok) => ok && onDone());
  return (
    <Modal
      title={`Price: ${quote.subject}`}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void send()}>Send {formatNaira(total)}</button></>}
    >
      <p className="muted" style={{ margin: 0 }}>{quote.requestDetails}</p>
      {items.map((item, n) => (
        <div key={n} className="form-grid">
          <Field label="What is it?"><input value={item.description} onChange={(e) => update(n, { description: e.target.value })} /></Field>
          <Field label="Quantity"><input inputMode="numeric" value={item.quantity} onChange={(e) => update(n, { quantity: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Price each (₦)"><MoneyInput value={item.unitPriceMinor} onChange={(v) => update(n, { unitPriceMinor: v })} /></Field>
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setItems((xs) => [...xs, { description: '', quantity: 1, unitPriceMinor: null }])}>Add a line</button></div>
      <Field label="Valid until"><input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
    </Modal>
  );
}

// Requested, quoted and confirmed are set by the quote and the payment, not by hand.
const LOGISTICS = ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];

function Logistics() {
  const list = useLoad(() => get<{ data: any[] }>('/admin/logistics/requests?pageSize=100').then((r) => r.data));
  const [quote, setQuote] = useState<any>(null);
  const [event, setEvent] = useState<any>(null);
  return (
    <>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Tracking</th><th>Customer</th><th>Route</th><th>Package</th><th className="num">Price</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={7} className="empty">No logistics requests yet.</td></tr>}
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.trackingNumber}<div className="muted">{words(r.type)}</div></td>
                  <td>{contactEmail(r.user)}<div className="muted small">{contactPhone(r.user)}</div></td>
                  <td className="small">{place(r.originAddress)} → {place(r.destinationAddress)}</td>
                  <td className="small">{r.packageDescription}</td>
                  <td className="num">{r.quotedPriceMinor != null ? formatNaira(r.quotedPriceMinor) : '—'}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td>
                    <div className="row-actions">
                      {['REQUESTED', 'QUOTED'].includes(r.status) && <button className="btn sm primary" onClick={() => setQuote(r)}>Quote</button>}
                      {!['DELIVERED', 'CANCELLED'].includes(r.status) && <button className="btn sm" onClick={() => setEvent(r)}>Update</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {quote && <LogisticsQuote request={quote} onClose={() => setQuote(null)} onDone={() => { setQuote(null); void list.reload(); }} />}
      {event && <LogisticsEvent request={event} onClose={() => setEvent(null)} onDone={() => { setEvent(null); void list.reload(); }} />}
    </>
  );
}

function LogisticsQuote({ request, onClose, onDone }: { request: any; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [price, setPrice] = useState<number | null>(request.quotedPriceMinor);
  const save = () => run(() => post(`/admin/logistics/requests/${request.id}/quote`, { quotedPriceMinor: price }), 'Quote sent').then((ok) => ok && onDone());
  return (
    <Modal title={`Quote ${request.trackingNumber}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!price || busy} onClick={() => void save()}>Send quote</button></>}>
      <Field label="Price (₦)"><MoneyInput value={price} onChange={setPrice} /></Field>
    </Modal>
  );
}

function LogisticsEvent({ request, onClose, onDone }: { request: any; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [status, setStatus] = useState<string>(LOGISTICS.includes(request.status) ? request.status : LOGISTICS[0]);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const save = () =>
    run(() => post(`/admin/logistics/requests/${request.id}/events`, { status, ...(location.trim() ? { location: location.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }), 'Tracking updated').then((ok) => ok && onDone());
  return (
    <Modal title={`Update ${request.trackingNumber}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}>Save</button></>}>
      <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}>{LOGISTICS.map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></Field>
      <Field label="Where is it? (optional)"><input value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
      <Field label="Note for the customer (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function Deliveries() {
  const list = useLoad(() => get<{ data: any[] }>('/admin/delivery/deliveries?pageSize=100').then((r) => r.data));
  const { run } = useAction();
  const setStatus = (d: any, status: string) => {
    const failureReason = status === 'FAILED' ? window.prompt('Why did the delivery fail?')?.trim() : undefined;
    if (status === 'FAILED' && !failureReason) return;
    void run(() => patch(`/admin/delivery/deliveries/${d.id}`, { status, ...(failureReason ? { failureReason } : {}) }), 'Delivery updated').then(() => list.reload());
  };
  return (
    <>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Deliver to</th><th>Zone</th><th className="num">Order total</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={5} className="empty">No deliveries yet.</td></tr>}
              {list.data.map((d) => {
                const a = d.order?.deliveryAddress;
                return (
                  <tr key={d.id}>
                    <td className="mono small">{d.order?.orderNumber}</td>
                    <td className="small">{a?.recipientName}{a?.phone && <> · <a href={`tel:${a.phone}`}>{a.phone}</a></>}<div className="muted">{place(a)}</div></td>
                    <td className="small">{d.zone?.name ?? '—'}</td>
                    <td className="num">{formatNaira(d.order?.totalMinor)}</td>
                    <td>
                      <select aria-label="Delivery status" value={d.status} onChange={(e) => setStatus(d, e.target.value)}>
                        {['PENDING', 'SCHEDULED', 'DISPATCHED', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'].map((s) => <option key={s} value={s}>{words(s)}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

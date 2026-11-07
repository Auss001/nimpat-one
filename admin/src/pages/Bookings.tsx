import { useState } from 'react';
import { useAccess } from '../access';
import { contactEmail, contactPhone, get, patch } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira } from '../money';

type Tab = 'pharmacy' | 'spa' | 'other';
const PHARMACY = 'pharmacy-laboratory';
const SPA = 'spa-wellness';

interface Booking {
  id: string;
  bookingNumber: string;
  status: string;
  scheduledStart: string | null;
  priceMinor: number | null;
  customerNote: string | null;
  details: Record<string, unknown> | null;
  atHome?: boolean;
  serviceAddress?: HomeAddress | null;
  divisionId: string;
  offering: { name: string; pricingType: string; category?: string | null };
  user: { email: string; phone: string | null };
}
interface Appointment {
  id: string;
  status: string;
  startsAt: string;
  customerNote: string | null;
  atHome?: boolean;
  homeAddress?: HomeAddress | null;
  treatment: { name: string };
  practitioner: { displayName: string } | null;
  user: { email: string; phone: string | null };
}

interface HomeAddress { recipientName?: string; phone?: string; line1?: string; line2?: string | null; landmark?: string | null; city?: string; state?: string }
/** "At home: 2 Test Street, near the market, Wuye, FCT · Ada 0803…" for a home visit. */
function HomeVisit({ address }: { address?: HomeAddress | null }) {
  if (!address) return null;
  const where = [address.line1, address.line2, address.landmark && `near ${address.landmark}`, address.city, address.state].filter(Boolean).join(', ');
  return <div className="small"><strong>At home:</strong> {where}{address.recipientName ? ` · ${address.recipientName}` : ''}{address.phone ? ` ${address.phone}` : ''}</div>;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : 'No time chosen');
const NEXT: Record<string, [string, string, boolean?][]> = {
  REQUESTED: [['CONFIRMED', 'Confirm'], ['CANCELLED', 'Cancel', true]],
  PENDING: [['CONFIRMED', 'Confirm'], ['CANCELLED', 'Cancel', true]],
  CONFIRMED: [['COMPLETED', 'Complete'], ['NO_SHOW', 'No show', true], ['CANCELLED', 'Cancel', true]],
  IN_PROGRESS: [['COMPLETED', 'Complete']],
};

/** Requests for spa, pharmacy and laboratory services, from any channel that books through the API. */
export function BookingsPage() {
  const { can } = useAccess();
  const tabs: { value: Tab; label: string }[] = [
    ...(can({ any: ['bookings:read'], division: PHARMACY }) ? [{ value: 'pharmacy' as Tab, label: 'Pharmacy & laboratory' }] : []),
    ...(can({ any: ['bookings:read'], division: SPA }) ? [{ value: 'spa' as Tab, label: 'Spa' }] : []),
    { value: 'other', label: 'Other services' },
  ];
  const [tab, setTab] = useState<Tab>(tabs[0].value);
  return (
    <>
      <PageHead title="Bookings" subtitle="Confirm, price and complete requests for the spa, pharmacy and laboratory, car hire, hire purchase, logistics and every other service, including home visits." />
      <div className="toolbar"><Tabs<Tab> value={tabs.some((t) => t.value === tab) ? tab : tabs[0].value} onChange={setTab} options={tabs} /></div>
      {tab === 'spa' ? <SpaBookings /> : <ServiceBookings key={tab} tab={tab} />}
    </>
  );
}

function SpaBookings() {
  const list = useLoad(() => get<{ data: Appointment[] }>('/admin/spa/appointments?pageSize=100').then((r) => r.data));
  const { run } = useAction();
  const move = (a: Appointment, status: string, label: string) =>
    run(async () => {
      await patch(`/admin/spa/appointments/${a.id}`, { status });
      await list.reload();
    }, `Appointment: ${label.toLowerCase()}`);
  return (
    <>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Treatment</th><th>Customer</th><th>When</th><th>Therapist</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={6} className="empty">No spa appointments yet.</td></tr>}
              {list.data.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.treatment.name}</strong>{a.atHome && <HomeVisit address={a.homeAddress} />}{a.customerNote && <div className="muted small">{a.customerNote}</div>}</td>
                  <td>{contactEmail(a.user)}<div className="muted small">{contactPhone(a.user)}</div></td>
                  <td className="small">{when(a.startsAt)}</td>
                  <td className="small">{a.practitioner?.displayName ?? <span className="muted">Any</span>}</td>
                  <td><StatusPill status={a.status} /></td>
                  <td><div className="row-actions">{(NEXT[a.status] ?? []).map(([to, label, danger]) => <button key={to} className={`btn sm ${danger ? 'danger' : 'primary'}`} onClick={() => void move(a, to, label)}>{label}</button>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ServiceBookings({ tab }: { tab: Tab }) {
  const { divisions } = useAccess();
  const pharmacyId = divisions.find((d) => d.slug === PHARMACY)?.id;
  const list = useLoad(
    () => get<{ data: Booking[] }>(`/admin/services/bookings?pageSize=100${tab === 'pharmacy' ? `&division=${PHARMACY}` : ''}`).then((r) => r.data),
    [tab],
  );
  const [pricing, setPricing] = useState<Booking | null>(null);
  const { run } = useAction();
  const rows = (list.data ?? []).filter((b) => tab === 'pharmacy' || b.divisionId !== pharmacyId);
  const move = (b: Booking, status: string, label: string) =>
    run(async () => {
      await patch(`/admin/services/bookings/${b.id}`, { status });
      await list.reload();
    }, `${b.bookingNumber}: ${label.toLowerCase()}`);
  return (
    <>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Booking</th><th>Customer</th><th>When</th><th className="num">Price</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="empty">No bookings yet.</td></tr>}
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.offering.name}</strong>
                    <div className="muted small mono">{b.bookingNumber}{b.offering.category ? ` · ${b.offering.category}` : ''}</div>
                    {b.atHome && <HomeVisit address={b.serviceAddress} />}
                    {b.customerNote && <div className="muted small">{b.customerNote}</div>}
                    {b.details && <div className="muted small">{Object.entries(b.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>}
                  </td>
                  <td>{contactEmail(b.user)}<div className="muted small">{contactPhone(b.user)}</div></td>
                  <td className="small">{when(b.scheduledStart)}</td>
                  <td className="num">{b.priceMinor !== null ? formatNaira(b.priceMinor) : <span className="muted">To be quoted</span>}</td>
                  <td><StatusPill status={b.status} /></td>
                  <td>
                    <div className="row-actions">
                      {b.status === 'REQUESTED' && <button className="btn sm" onClick={() => setPricing(b)}>Price and request payment</button>}
                      {(NEXT[b.status] ?? []).map(([to, label, danger]) => <button key={to} className={`btn sm ${danger ? 'danger' : 'primary'}`} onClick={() => void move(b, to, label)}>{label}</button>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pricing && <PriceForm booking={pricing} onClose={() => setPricing(null)} onSaved={() => { setPricing(null); void list.reload(); }} />}
    </>
  );
}

function PriceForm({ booking, onClose, onSaved }: { booking: Booking; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [price, setPrice] = useState<number | null>(booking.priceMinor);
  const save = () => run(() => patch(`/admin/services/bookings/${booking.id}`, { priceMinor: price, status: 'PENDING' }), 'Sent for payment').then((ok) => ok && onSaved());
  return (
    <Modal title={`Price ${booking.offering.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!price || busy} onClick={() => void save()}>Request payment</button></>}>
      <Field label="Price (₦)" hint="The customer is asked to pay this amount"><MoneyInput value={price} onChange={setPrice} /></Field>
    </Modal>
  );
}

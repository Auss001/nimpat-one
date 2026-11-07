import { useState } from 'react';
import { contactEmail, contactPhone, get, patch } from '../api';
import { Loading, PageHead, StatusPill, Tabs, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface Reservation {
  room: { id: string; name: string } | null;
  id: string;
  reservationNumber: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  status: string;
  paymentStatus: string;
  amountPaidMinor: number;
  depositRequiredMinor: number;
  totalMinor: number;
  unit: { name: string; property: { name: string } };
  user: { email: string; phone: string | null; customerProfile: { firstName: string; lastName: string } | null };
}

const ACTIONS: Record<string, { to: string; label: string; danger?: boolean }[]> = {
  HOLD: [{ to: 'CONFIRMED', label: 'Approve' }, { to: 'CANCELLED', label: 'Cancel', danger: true }],
  CONFIRMED: [{ to: 'CHECKED_IN', label: 'Check in' }, { to: 'CANCELLED', label: 'Cancel', danger: true }],
  CHECKED_IN: [{ to: 'COMPLETED', label: 'Check out' }],
};

type Filter = 'CONFIRMED' | 'CHECKED_IN' | 'HOLD' | '';

export function ReservationsPage() {
  const [status, setStatus] = useState<Filter>('CONFIRMED');
  const today = new Date().toISOString().slice(0, 10);
  const list = useLoad(
    () => get<{ data: Reservation[] }>(`/admin/apartments/reservations?pageSize=100&from=${today}${status ? `&status=${status}` : ''}`).then((r) => r.data),
    [status],
  );
  const { run, busy } = useAction();
  const { ask, dialog } = useConfirm();
  const move = (r: Reservation, to: string, label: string) =>
    run(async () => {
      await patch(`/admin/apartments/reservations/${r.id}/status`, { status: to });
      await list.reload();
    }, `${r.reservationNumber}: ${label.toLowerCase()}`);

  return (
    <>
      <PageHead title="Apartment reservations" subtitle="Upcoming and current stays. Unpaid holds expire automatically. Approve applies only when the payment rules require staff approval." />
      <div className="toolbar">
        <Tabs<Filter>
          value={status}
          onChange={setStatus}
          options={[{ value: 'CONFIRMED', label: 'Confirmed' }, { value: 'CHECKED_IN', label: 'In house' }, { value: 'HOLD', label: 'Awaiting payment' }, { value: '', label: 'All upcoming' }]}
        />
      </div>
      {dialog}
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Reservation</th><th>Guest</th><th>Apartment</th><th>Stay</th><th className="num">Total</th><th className="num">Paid</th><th>Status</th><th>Payment</th><th></th></tr></thead>
            <tbody>
              {list.data.length === 0 && <tr><td colSpan={9} className="empty">No reservations.</td></tr>}
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.reservationNumber}</td>
                  <td>{r.user.customerProfile ? `${r.user.customerProfile.firstName} ${r.user.customerProfile.lastName}` : contactEmail(r.user)}<div className="muted small">{contactPhone(r.user) ?? contactEmail(r.user)}</div></td>
                  <td>{r.room ? `${r.room.name}, ${r.unit.name}` : r.unit.name}<div className="muted small">{r.unit.property.name}{r.room ? ' · one room' : ''}</div></td>
                  <td className="small">{r.checkIn.slice(0, 10)} → {r.checkOut.slice(0, 10)}<div className="muted">{r.nights} night{r.nights > 1 ? 's' : ''} · {r.guests} guest{r.guests > 1 ? 's' : ''}</div></td>
                  <td className="num">{formatNaira(r.totalMinor)}</td>
                  <td className="num">{formatNaira(r.amountPaidMinor)}{r.depositRequiredMinor > 0 && <div className="muted small">deposit {formatNaira(r.depositRequiredMinor)}</div>}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td><StatusPill status={r.paymentStatus} /></td>
                  <td><div className="row-actions">
                    {(ACTIONS[r.status] ?? []).map((a) => (
                      <button key={a.to} className={`btn sm ${a.danger ? 'danger' : 'primary'}`} disabled={busy}
                        onClick={() => (a.danger ? ask(`Cancel ${r.reservationNumber}? The guest will be notified.`, () => void move(r, a.to, a.label), 'Cancel reservation') : void move(r, a.to, a.label))}>{a.label}</button>
                    ))}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

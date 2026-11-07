import { useState } from 'react';
import { contactEmail, contactPhone, get, openProtectedFile, post } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useLoad, useToast } from '../components/ui';
import { formatNaira } from '../money';

type Queue = 'online' | 'transfers' | 'collections' | 'pod' | 'balances' | 'disputes' | 'reconcile' | 'history' | 'staff' | 'all';

const QUEUES: { value: Queue; label: string }[] = [
  { value: 'transfers', label: 'Bank transfers' },
  { value: 'online', label: 'Paid online' },
  { value: 'collections', label: 'Collections' },
  { value: 'pod', label: 'Pay on delivery' },
  { value: 'balances', label: 'Deposits & balances' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'reconcile', label: 'To reconcile' },
  { value: 'history', label: 'Reconciled' },
  { value: 'staff', label: 'Staff accountability' },
  { value: 'all', label: 'All payments' },
];

const QUEUE_FILTER: Partial<Record<Queue, string>> = {
  transfers: 'method=BANK_TRANSFER&collectionPoint=BANK&status=AWAITING_VERIFICATION',
  online: 'method=PAYSTACK&status=SUCCESS',
  collections: 'status=AWAITING_VERIFICATION',
  disputes: 'reconciliationStatus=DISPUTED',
  reconcile: 'reconciliationStatus=COLLECTION_VERIFIED',
  history: 'reconciliationStatus=RECONCILED',
  all: '',
};

const DIVISIONS: [string, string][] = [
  ['', 'All departments'],
  ['water-drinks-wines', 'Water, Drinks & Wines'],
  ['luxury-apartments', 'Luxury Apartments'],
  ['automobiles', 'Automobiles'],
  ['spa-wellness', 'Spa & Wellness'],
  ['transport-logistics', 'Transport & Logistics'],
  ['retail-general-supplies', 'Retail & Supplies'],
  ['media-events-rentals', 'Media, Events & Rentals'],
  ['real-estate-interior-design', 'Real Estate & Interior'],
  ['entertainment', 'Entertainment'],
];

const words = (s?: string | null) => (s ?? '').replace(/_/g, ' ').toLowerCase();

const payableLabel = (p: any) =>
  p.order?.orderNumber ?? p.reservation?.reservationNumber ?? p.serviceBooking?.bookingNumber ?? p.spaAppointment?.appointmentNumber ?? words(p.purpose);

export function PaymentsPage() {
  const [queue, setQueue] = useState<Queue>('transfers');
  const [division, setDivision] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const usesPayments = queue in QUEUE_FILTER;
  const qs = [
    QUEUE_FILTER[queue],
    division && `division=${division}`,
    method && `method=${method}`,
    status && `status=${status}`,
    locationId && `serviceLocationId=${locationId}`,
    staffId && `reportedById=${staffId}`,
    from && `from=${from}T00:00:00.000Z`,
    to && `to=${to}T23:59:59.999Z`,
  ].filter(Boolean).join('&');

  const payments = useLoad(async () => {
    if (!usesPayments) return null;
    const res = await get(`/admin/payments?pageSize=100&${qs}`);
    // "Collections" means money staff reported, not customer transfers.
    if (queue === 'collections') res.data = res.data.filter((p: any) => p.collectionPoint === 'DELIVERY' || p.collectionPoint === 'SERVICE_LOCATION');
    return res;
  }, [qs, queue]);
  const locations = useLoad(() => get<any[]>('/admin/payment-settings/service-locations').catch(() => []));
  const staffReport = useLoad(() => get<any[]>(`/admin/finance/collections-by-staff${division ? `?division=${division}` : ''}`).catch(() => []), [division]);

  return (
    <>
      <PageHead title="Payments" subtitle="Reported money counts as paid only after finance confirms it against trusted bank or cash records." />
      <div className="toolbar"><Tabs value={queue} onChange={setQueue} options={QUEUES} /></div>
      <div className="toolbar">
        <select style={{ width: 'auto' }} aria-label="Department" value={division} onChange={(e) => setDivision(e.target.value)}>
          {DIVISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {usesPayments && (
          <>
            <select style={{ width: 'auto' }} aria-label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">All methods</option>
              <option value="PAYSTACK">Paystack</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="CARD_TERMINAL">Card terminal</option>
            </select>
            {queue === 'all' && (
              <select style={{ width: 'auto' }} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {['PENDING', 'AWAITING_VERIFICATION', 'SUCCESS', 'FAILED', 'REJECTED', 'REVERSED', 'ABANDONED'].map((s) => <option key={s} value={s}>{words(s)}</option>)}
              </select>
            )}
            <select style={{ width: 'auto' }} aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select style={{ width: 'auto' }} aria-label="Staff member" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">All staff</option>
              {staffReport.data?.map((s) => <option key={s.staff.id} value={s.staff.id}>{s.staff.staffProfile ? `${s.staff.staffProfile.firstName} ${s.staff.staffProfile.lastName}` : s.staff.email}</option>)}
            </select>
            <input type="date" style={{ width: 'auto' }} aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" style={{ width: 'auto' }} aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
      </div>

      {usesPayments && <Loading error={payments.error} loading={payments.loading && !payments.data} />}
      {usesPayments && payments.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Reference</th><th>For</th><th>Customer</th><th>Method</th><th>Reported by</th><th className="num">Claimed</th><th className="num">Amount</th><th>Status</th><th>Reconciliation</th><th></th></tr></thead>
            <tbody>
              {payments.data.data.length === 0 && <tr><td colSpan={10} className="empty">Nothing here.</td></tr>}
              {payments.data.data.map((p: any) => (
                <tr key={p.id}>
                  <td className="mono">{p.reference}<div className="muted small">{new Date(p.createdAt).toLocaleString('en-NG')}</div></td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{payableLabel(p)}<div className="muted">{p.division?.name}</div></td>
                  <td className="small">{contactEmail(p.user)}</td>
                  <td className="small">{words(p.method)}<div className="muted">{p.serviceLocation?.name ?? words(p.collectionPoint)}</div></td>
                  <td className="small">{p.reportedBy?.staffProfile ? `${p.reportedBy.staffProfile.firstName} ${p.reportedBy.staffProfile.lastName}` : p.reportedById ? 'Customer' : '—'}</td>
                  <td className="num">{p.claimedAmountMinor != null ? formatNaira(p.claimedAmountMinor) : '—'}</td>
                  <td className="num">{formatNaira(p.amountMinor)}</td>
                  <td><StatusPill status={p.status} /></td>
                  <td><Pill tone={p.reconciliationStatus === 'DISPUTED' ? 'red' : p.reconciliationStatus === 'RECONCILED' ? 'green' : p.reconciliationStatus === 'COLLECTION_VERIFIED' ? 'blue' : undefined}>{words(p.reconciliationStatus)}</Pill></td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setOpen(p.id)}>Open</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {queue === 'pod' && <PodOrders division={division} />}
      {queue === 'balances' && <Balances division={division} />}
      {queue === 'staff' && <StaffReport data={staffReport.data} error={staffReport.error} />}
      {open && <PaymentDetail id={open} onClose={() => setOpen(null)} onChanged={() => void payments.reload()} />}
    </>
  );
}

function PodOrders({ division }: { division: string }) {
  const orders = useLoad(() => get(`/admin/orders?paymentOption=PAY_ON_DELIVERY&pageSize=100${division ? `&division=${division}` : ''}`), [division]);
  return (
    <>
      <Loading error={orders.error} loading={orders.loading && !orders.data} />
      {orders.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Delivery</th><th>Order status</th><th>Payment</th><th className="num">Total</th><th className="num">Outstanding</th></tr></thead>
            <tbody>
              {orders.data.data.length === 0 && <tr><td colSpan={7} className="empty">No pay-on-delivery orders yet.</td></tr>}
              {orders.data.data.map((o: any) => (
                <tr key={o.id}>
                  <td className="mono">{o.orderNumber}</td>
                  <td className="small">{contactEmail(o.user)}</td>
                  <td className="small">{words(o.delivery?.status) || '—'}</td>
                  <td><StatusPill status={o.status} /></td>
                  <td><StatusPill status={o.paymentStatus} /></td>
                  <td className="num">{formatNaira(o.totalMinor)}</td>
                  <td className="num">{formatNaira(o.outstandingMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Balances({ division }: { division: string }) {
  const rows = useLoad(() => get<any[]>(`/admin/finance/outstanding${division ? `?division=${division}` : ''}`), [division]);
  return (
    <>
      <Loading error={rows.error} loading={rows.loading && !rows.data} />
      {rows.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Type</th><th>Customer</th><th>Status</th><th>Payment</th><th className="num">Total due</th><th className="num">Deposit</th><th className="num">Paid</th><th className="num">Outstanding</th></tr></thead>
            <tbody>
              {rows.data.length === 0 && <tr><td colSpan={9} className="empty">No outstanding balances.</td></tr>}
              {rows.data.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.label}<div className="muted small">{r.date ? new Date(r.date).toLocaleDateString('en-NG') : ''}</div></td>
                  <td className="small">{words(r.purpose)}{r.paymentOption ? <div className="muted">{words(r.paymentOption)}</div> : null}</td>
                  <td className="small">{r.customer}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td><StatusPill status={r.paymentStatus} /></td>
                  <td className="num">{formatNaira(r.totalDueMinor)}</td>
                  <td className="num">{r.depositRequiredMinor ? formatNaira(r.depositRequiredMinor) : '—'}</td>
                  <td className="num">{formatNaira(r.paidMinor)}</td>
                  <td className="num"><strong>{formatNaira(r.outstandingMinor)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StaffReport({ data, error }: { data: any[] | null; error: string | null }) {
  return (
    <>
      <Loading error={error} loading={!data} />
      {data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Staff member</th><th className="num">Collections</th><th className="num">Reported</th><th className="num">Awaiting</th><th className="num">Verified</th><th className="num">Rejected</th><th className="num">Shortfall</th></tr></thead>
            <tbody>
              {data.length === 0 && <tr><td colSpan={7} className="empty">No staff collections yet.</td></tr>}
              {data.map((r) => (
                <tr key={r.staff.id}>
                  <td>{r.staff.staffProfile ? `${r.staff.staffProfile.firstName} ${r.staff.staffProfile.lastName}` : r.staff.email}<div className="muted small">{r.staff.staffProfile?.employeeNumber}</div></td>
                  <td className="num">{r.collections}</td>
                  <td className="num">{formatNaira(r.reportedMinor)}</td>
                  <td className="num">{formatNaira(r.awaitingVerificationMinor)}</td>
                  <td className="num">{formatNaira(r.verifiedMinor)}</td>
                  <td className="num">{formatNaira(r.rejectedMinor)}</td>
                  <td className="num">{r.shortfallMinor > 0 ? <Pill tone="red">{formatNaira(r.shortfallMinor)}</Pill> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Action = 'confirm' | 'reject' | 'dispute' | 'resolve' | 'reverse' | 'reconcile' | 'refund' | null;

function PaymentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const payment = useLoad(() => get<any>(`/admin/payments/${id}`), [id]);
  const [action, setAction] = useState<Action>(null);
  const toast = useToast();
  const p = payment.data;
  const manual = p && p.method !== 'PAYSTACK';
  const verifiable = p && (p.status === 'PENDING' || p.status === 'AWAITING_VERIFICATION');

  return (
    <Modal
      title={p ? `Payment ${p.reference}` : 'Payment'}
      onClose={onClose}
      wide
      footer={p && (
        <>
          {manual && verifiable && <button className="btn primary" onClick={() => setAction('confirm')}>Confirm funds received</button>}
          {manual && verifiable && <button className="btn danger" onClick={() => setAction('reject')}>Reject</button>}
          {manual && (verifiable || p.status === 'SUCCESS') && p.reconciliationStatus !== 'DISPUTED' && p.reconciliationStatus !== 'RECONCILED' && <button className="btn" onClick={() => setAction('dispute')}>Dispute</button>}
          {p.status === 'SUCCESS' && p.reconciliationStatus === 'DISPUTED' && <button className="btn" onClick={() => setAction('resolve')}>Resolve dispute</button>}
          {p.status === 'SUCCESS' && p.reconciliationStatus === 'COLLECTION_VERIFIED' && <button className="btn primary" onClick={() => setAction('reconcile')}>Reconcile</button>}
          {manual && p.status === 'SUCCESS' && p.reconciliationStatus !== 'RECONCILED' && <button className="btn danger" onClick={() => setAction('reverse')}>Reverse</button>}
          {!manual && p.status === 'SUCCESS' && <button className="btn danger" onClick={() => setAction('refund')}>Refund</button>}
        </>
      )}
    >
      <Loading error={payment.error} loading={payment.loading && !p} />
      {p && (
        <>
          <div className="toolbar" style={{ margin: 0 }}>
            <StatusPill status={p.status} />
            <Pill tone={p.reconciliationStatus === 'DISPUTED' ? 'red' : undefined}>{words(p.reconciliationStatus)}</Pill>
            <span className="muted small">{words(p.purpose)} · {words(p.method)} · {words(p.collectionPoint)}</span>
          </div>
          <div className="form-grid small">
            <div><span className="muted">Amount</span><br /><strong>{formatNaira(p.amountMinor)}</strong></div>
            <div><span className="muted">Claimed by payer / collector</span><br />{p.claimedAmountMinor != null ? formatNaira(p.claimedAmountMinor) : '—'}</div>
            <div><span className="muted">Customer</span><br />{contactEmail(p.user)}{contactPhone(p.user) ? ` · ${contactPhone(p.user)}` : ''}</div>
            <div><span className="muted">Payer name</span><br />{p.payerName ?? '—'}</div>
            <div><span className="muted">Payer's reference</span><br />{p.customerReference ?? '—'}</div>
            <div><span className="muted">Receipt</span><br />{p.receiptNumber ?? '—'}</div>
            <div><span className="muted">Reported by</span><br />{p.reportedBy?.email ?? '—'}{p.reportedAt ? ` · ${new Date(p.reportedAt).toLocaleString('en-NG')}` : ''}</div>
            <div><span className="muted">Collected at</span><br />{p.collectedAt ? new Date(p.collectedAt).toLocaleString('en-NG') : p.transferredAt ? new Date(p.transferredAt).toLocaleString('en-NG') : '—'}{p.serviceLocation ? ` · ${p.serviceLocation.name}` : ''}</div>
            <div><span className="muted">Verified by</span><br />{p.verifiedBy?.email ?? '—'}{p.verificationReference ? ` · ${p.verificationReference}` : ''}</div>
            <div><span className="muted">Reconciled by</span><br />{p.reconciledBy?.email ?? '—'}{p.settlementReference ? ` · ${p.settlementReference}` : ''}</div>
          </div>
          {p.note && <div className="banner info" style={{ margin: 0 }}>{p.note}</div>}
          {p.disputeReason && <div className="banner warn" style={{ margin: 0 }}><strong>Dispute:</strong> {p.disputeReason}</div>}
          {p.rejectionReason && <div className="banner error" style={{ margin: 0 }}><strong>Rejected:</strong> {p.rejectionReason}</div>}
          {p.failureReason && <div className="banner warn" style={{ margin: 0 }}>{p.failureReason}</div>}
          {p.proofs.length > 0 && (
            <div>
              <h3 style={{ marginBottom: 4 }}>Customer's proof</h3>
              <p className="muted small" style={{ margin: '0 0 6px' }}>Supporting evidence only. Always confirm against bank records.</p>
              {p.proofs.map((f: any) => (
                <button key={f.id} className="btn sm" style={{ marginRight: 6 }} onClick={() => openProtectedFile(`/payments/proofs/${f.id}`).catch((e) => toast(e.message, 'error'))}>{f.fileName}</button>
              ))}
            </div>
          )}
          <div>
            <h3 style={{ marginBottom: 6 }}>History</h3>
            {p.events.map((e: any) => (
              <div key={e.id} className="small"><span className="muted">{new Date(e.createdAt).toLocaleString('en-NG')}</span> — {e.eventType}</div>
            ))}
          </div>
        </>
      )}
      {action && p && <ActionDialog action={action} payment={p} onClose={() => setAction(null)} onDone={() => { setAction(null); void payment.reload(); onChanged(); }} />}
    </Modal>
  );
}

function ActionDialog({ action, payment, onClose, onDone }: { action: Exclude<Action, null>; payment: any; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [amount, setAmount] = useState<number | null>(action === 'refund' ? null : payment.claimedAmountMinor ?? payment.amountMinor);
  const [text, setText] = useState('');
  const config = {
    confirm: { title: 'Confirm funds received', label: 'Bank statement line / cash book reference', btn: 'Confirm funds', path: 'confirm-funds', ok: 'Funds confirmed' },
    reject: { title: 'Reject payment', label: 'Reason (shown to the customer)', btn: 'Reject', path: 'reject', ok: 'Payment rejected' },
    dispute: { title: 'Open a dispute', label: 'What needs investigating?', btn: 'Open dispute', path: 'dispute', ok: 'Dispute opened' },
    resolve: { title: 'Resolve dispute', label: 'Outcome of the investigation', btn: 'Resolve', path: 'resolve-dispute', ok: 'Dispute resolved' },
    reverse: { title: 'Reverse payment', label: 'Reason (shown to the customer)', btn: 'Reverse payment', path: 'reverse', ok: 'Payment reversed' },
    reconcile: { title: 'Reconcile', label: 'Bank settlement / cash banking reference', btn: 'Mark reconciled', path: 'reconcile', ok: 'Payment reconciled' },
    refund: { title: 'Refund through Paystack', label: 'Reason for the refund', btn: 'Refund', path: 'refunds', ok: 'Refund requested' },
  }[action];
  const valid = text.trim().length >= 3 && (action !== 'confirm' || (amount !== null && amount > 0));
  const body =
    action === 'confirm' ? { receivedAmountMinor: amount, verificationReference: text.trim() }
    : action === 'resolve' ? { note: text.trim() }
    : action === 'reconcile' ? { settlementReference: text.trim() }
    : action === 'refund' ? { reason: text.trim(), ...(amount ? { amountMinor: amount } : {}) }
    : { reason: text.trim() };
  const save = () => run(() => post(`/admin/payments/${payment.id}/${config.path}`, body), config.ok).then((ok) => ok && onDone());
  return (
    <Modal title={config.title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>{config.btn}</button></>}>
      {action === 'confirm' && (
        <>
          <div className="banner warn" style={{ margin: 0 }}>Check the money in the bank statement or cash book. Do not rely on a screenshot or on what was reported.</div>
          <Field label="Amount actually received (₦)"><MoneyInput value={amount} onChange={setAmount} /></Field>
        </>
      )}
      {action === 'refund' && <Field label="Amount (₦)" hint={`Leave empty to refund the full ${formatNaira(payment.amountMinor)}.`}><MoneyInput value={amount} onChange={setAmount} /></Field>}
      <Field label={config.label}>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}


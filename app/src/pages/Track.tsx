import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, MapPin, MessageCircle, Package, Store, Truck } from 'lucide-react';
import { formatNaira, get } from '../api';
import { CallLink, dateTime, Loader, Note, PageTitle, Status, useLoad, useSession } from '../ui';
import { whatsappLink } from './Help';

/** Each step a customer sees, and the order statuses that mean it has been reached. */
function stepsFor(pickup: boolean): { label: string; reached: string[] }[] {
  return [
    { label: 'Order placed', reached: ['PENDING', 'ACCEPTED', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'] },
    { label: 'Accepted', reached: ['ACCEPTED', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'] },
    { label: 'Being prepared', reached: ['PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'] },
    pickup
      ? { label: 'Ready to collect', reached: ['READY', 'DELIVERED', 'COMPLETED'] }
      : { label: 'On the way', reached: ['OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'] },
    { label: pickup ? 'Collected' : 'Delivered', reached: ['DELIVERED', 'COMPLETED'] },
  ];
}

const HISTORY_LABEL: Record<string, string> = {
  PENDING: 'Order placed', ACCEPTED: 'Order accepted', PROCESSING: 'Being prepared', READY: 'Ready', OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered', COMPLETED: 'Completed', CANCELLED: 'Cancelled', EXPIRED: 'Expired: not paid in time',
};

/** One order, from placed to delivered. It refreshes itself while open. */
export function TrackOrderPage() {
  const { id = '' } = useParams();
  const session = useSession();
  const order = useLoad(() => (session ? get(`/orders/${id}`) : Promise.reject(new Error('Please sign in to see this order.'))), [id, session?.email]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void order.reload(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const o = order.data;
  if (order.loading && !o) return <Loader label="Finding your order" />;
  if (!o) return <><PageTitle title="Track order" /><Note tone="error">{order.error ?? 'This order was not found.'}</Note></>;

  const pickup = o.fulfilmentType === 'PICKUP';
  const steps = stepsFor(pickup);
  const stopped = ['CANCELLED', 'EXPIRED'].includes(o.status);
  const at = stopped ? -1 : steps.reduce((n, s, i) => (s.reached.includes(o.status) ? i : n), 0);
  const when = (status: string) => o.statusHistory?.filter((h: any) => h.toStatus === status).at(-1)?.createdAt;
  const address = o.deliveryAddress;
  const help = whatsappLink(`Hello Nimpat, I have a question about my order ${o.orderNumber}.`);

  return (
    <>
      <PageTitle title={`Order ${o.orderNumber}`} sub={`${o.division?.name ?? ''} · placed ${dateTime(o.createdAt)}`} />

      <section className="panel track">
        <div className="track-now">
          {pickup ? <Store size={22} aria-hidden="true" /> : <Truck size={22} aria-hidden="true" />}
          <div><b>{stopped ? HISTORY_LABEL[o.status] : steps[at].label}</b><small>{stopped ? 'This order is closed.' : at === steps.length - 1 ? 'Thank you for ordering with Nimpat.' : 'We will update this as your order moves.'}</small></div>
          <Status value={o.paymentStatus} />
        </div>
        {!stopped && (
          <ol className="track-steps">
            {steps.map((s, i) => {
              const time = s.reached.map(when).find(Boolean);
              return (
                <li key={s.label} className={i < at ? 'done' : i === at ? 'now' : ''}>
                  <span className="dot">{i <= at ? <Check size={13} aria-hidden="true" /> : null}</span>
                  <span className="txt"><b>{s.label}</b>{i <= at && time && <small>{dateTime(time)}</small>}</span>
                </li>
              );
            })}
          </ol>
        )}
        {o.delivery?.trackingCode && <p className="muted-text">Tracking code <b>{o.delivery.trackingCode}</b>{o.delivery.dispatchedAt ? ` · sent out ${dateTime(o.delivery.dispatchedAt)}` : ''}</p>}
      </section>

      {!pickup && address && (
        <section className="panel">
          <h2>Delivering to</h2>
          <div className="address-row"><MapPin size={18} aria-hidden="true" /><span><b>{address.recipientName}</b><small>{[address.line1, address.line2, address.city, address.state].filter(Boolean).join(', ')}{address.landmark ? ` (near ${address.landmark})` : ''}</small></span></div>
        </section>
      )}

      <section className="panel">
        <h2><Package size={18} aria-hidden="true" /> Items</h2>
        {o.items?.map((i: any) => <div key={i.id} className="sum"><span>{i.quantity} × {i.productName}{i.variantName && i.variantName !== 'As listed' ? ` (${i.variantName})` : ''}</span><span>{formatNaira(i.lineTotalMinor)}</span></div>)}
        {Number(o.taxMinor) > 0 && <div className="sum"><span>VAT</span><span>{formatNaira(o.taxMinor)}</span></div>}
        {!pickup && <div className="sum"><span>Delivery</span><span>{formatNaira(o.deliveryFeeMinor)}</span></div>}
        <div className="sum total"><span>Total</span><b>{formatNaira(o.totalMinor)}</b></div>
        {Number(o.outstandingMinor) > 0 && !stopped && <Link className="btn primary full" to={`/pay/ORDER/${o.id}`}>Pay {formatNaira(o.outstandingMinor)}</Link>}
      </section>

      <section className="panel">
        <h2>Need help with this order?</h2>
        <a className="btn wa full" href={help} target="_blank" rel="noreferrer"><MessageCircle size={17} aria-hidden="true" /> WhatsApp us about {o.orderNumber}</a>
        <CallLink />
      </section>
    </>
  );
}

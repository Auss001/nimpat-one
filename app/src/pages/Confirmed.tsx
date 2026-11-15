import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Bike, CalendarCheck, PackageCheck, ShoppingBag, Sparkles, Store } from 'lucide-react';
import { formatNaira, get } from '../api';
import { addressLine } from './Account';
import { Loader, Note, useCart, useLoad } from '../ui';

/**
 * The moment after paying (or placing a pay-later order): a clear, happy "it worked" screen instead of an empty basket.
 * A tick that draws itself, a small burst of Nimpat colours, what was paid, what happens next, and where to go now.
 */

const BURST = ['#0b6b3a', '#f2a900', '#ef7d22', '#1668b8', '#d93a32', '#0a7a3b', '#f2a900', '#ef7d22', '#1668b8', '#0b6b3a', '#d93a32', '#f2a900'];

function Celebration() {
  return (
    <div className="yay" aria-hidden="true">
      {BURST.map((c, i) => <i key={i} style={{ ['--a' as string]: `${(360 / BURST.length) * i}deg`, ['--c' as string]: c, ['--d' as string]: `${(i % 4) * 40}ms` }} />)}
      <svg viewBox="0 0 96 96" className="yay-tick">
        <circle cx="48" cy="48" r="44" />
        <path d="M29 50 L42 63 L68 35" />
      </svg>
    </div>
  );
}

const PAY_LATER: Record<string, string> = {
  PAY_ON_DELIVERY: 'Pay when it arrives',
  PAY_AT_LOCATION: 'Pay when you collect it',
  BANK_TRANSFER: 'Waiting for your transfer',
};

/** An order: what was bought, where it is going, and the three steps ahead. */
function OrderDone({ orderId, paidMinor }: { orderId: string; paidMinor?: number }) {
  const order = useLoad(() => get(`/orders/${orderId}`), [orderId]);
  const o = order.data;
  if (order.loading && !o) return <Loader label="Getting your order" />;
  if (!o) return <Note tone="error">{order.error ?? 'We could not load this order.'}</Note>;
  const pickup = o.fulfilmentType === 'PICKUP';
  const paid = (paidMinor ?? Number(o.amountPaidMinor ?? 0)) > 0;
  const items: any[] = o.items ?? [];
  const shown = items.slice(0, 4);
  return (
    <>
      <section className="yay-card">
        <Celebration />
        <h1>{paid ? 'Order confirmed!' : 'Order placed!'}</h1>
        <p className="yay-sub">
          {paid
            ? `Thank you. We've received ${formatNaira(paidMinor ?? o.amountPaidMinor)} and we're getting your order ready.`
            : `Thank you. ${PAY_LATER[o.paymentOption] ?? 'We have your order'}; we're getting it ready.`}
        </p>
        <span className="yay-chip"><ShoppingBag size={15} aria-hidden="true" /> Order {o.orderNumber}</span>
      </section>

      <section className="panel yay-steps" aria-label="What happens next">
        <div className="step done"><span><PackageCheck size={18} aria-hidden="true" /></span><b>{paid ? 'Paid' : 'Placed'}</b></div>
        <div className="bar done" />
        <div className="step now"><span><Sparkles size={18} aria-hidden="true" /></span><b>Preparing</b></div>
        <div className="bar" />
        <div className="step"><span>{pickup ? <Store size={18} aria-hidden="true" /> : <Bike size={18} aria-hidden="true" />}</span><b>{pickup ? 'Ready to collect' : 'On its way'}</b></div>
      </section>

      <section className="panel">
        <h2>Your order</h2>
        {shown.map((i) => (
          <div key={i.id} className="sum"><span>{i.quantity} × {i.productName}{i.variantName && i.variantName !== 'As listed' ? ` (${i.variantName})` : ''}</span><span>{formatNaira(i.lineTotalMinor)}</span></div>
        ))}
        {items.length > shown.length && <p className="muted-text">and {items.length - shown.length} more</p>}
        <div className="sum total"><span>Total</span><b>{formatNaira(o.totalMinor)}</b></div>
        <p className="muted-text yay-where">
          {pickup ? <><Store size={14} aria-hidden="true" /> Pick up at our store. We'll let you know when it's ready.</>
            : <><Bike size={14} aria-hidden="true" /> Delivering to {o.deliveryAddress ? addressLine(o.deliveryAddress) : 'your address'}.</>}
        </p>
      </section>

      <div className="yay-actions">
        <Link className="btn primary full" to={`/orders/${o.id}`}>Track my order <ArrowRight size={17} aria-hidden="true" /></Link>
        <Link className="btn ghost full" to="/">Keep shopping</Link>
      </div>
    </>
  );
}

const BOOKED: Record<string, { title: string; text: string; to: string; label: string }> = {
  APARTMENT_RESERVATION: { title: 'Your stay is booked!', text: 'We look forward to welcoming you. Your booking details are in your account.', to: '/bookings?tab=stays', label: 'See my stay' },
  SPA_APPOINTMENT: { title: 'Your spa visit is paid!', text: 'Our team will confirm your time and therapist shortly.', to: '/bookings?tab=spa', label: 'See my spa booking' },
  SERVICE_BOOKING: { title: 'Your booking is paid!', text: 'Our team will be in touch to confirm the details.', to: '/bookings?tab=services', label: 'See my booking' },
};

/** Shown on the payment result page once the payment is confirmed. */
export function PaymentSuccess({ payment }: { payment: any }) {
  const { refresh } = useCart();
  useEffect(() => { void refresh(); }, [refresh]); // the basket badge empties to match
  if (payment.orderId) return <OrderDone orderId={payment.orderId} paidMinor={Number(payment.amountMinor)} />;
  const b = BOOKED[payment.purpose] ?? { title: 'Payment received!', text: 'Thank you. Your payment is confirmed.', to: '/bookings', label: 'See my orders and bookings' };
  return (
    <>
      <section className="yay-card">
        <Celebration />
        <h1>{b.title}</h1>
        <p className="yay-sub">{formatNaira(payment.amountMinor)} paid. {b.text}</p>
        {payment.reference && <span className="yay-chip"><CalendarCheck size={15} aria-hidden="true" /> Ref {payment.reference}</span>}
      </section>
      <div className="yay-actions">
        <Link className="btn primary full" to={b.to}>{b.label} <ArrowRight size={17} aria-hidden="true" /></Link>
        <Link className="btn ghost full" to="/">Back to home</Link>
      </div>
    </>
  );
}

/** After placing a pay-later order (pay on delivery or at the store). */
export function OrderPlacedPage() {
  const { id = '' } = useParams();
  const { refresh } = useCart();
  useEffect(() => { void refresh(); }, [refresh]);
  return <OrderDone orderId={id} />;
}

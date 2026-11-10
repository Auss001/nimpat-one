import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banknote, Building, Check, Clock, CreditCard, MapPin, Minus, Pencil, Plus, Store, Trash2, Truck, Upload } from 'lucide-react';
import { api, del, formatNaira, get, getSession, idempotency, patch, post, rows } from '../api';
import { openPayment } from '../native';
import { AddressForm, addressLine, DetailsForm, VerifyEmailNote } from './Account';
import { CallLink, Empty, Field, Loader, Note, PageTitle, Photo, Sheet, Status, dateTime, useCart, useLoad, useToast } from '../ui';

const DIVISION_NAME: Record<string, string> = {
  'water-drinks-wines': 'Water & Drinks',
  'pharmacy-laboratory': 'Pharmacy',
  'retail-general-supplies': 'Supplies',
};

export function CartPage() {
  const session = getSession();
  const { carts, refresh, setLocalQty, clearLocal } = useCart();
  const toast = useToast();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void refresh().finally(() => setReady(true));
  }, [refresh]);
  const setQty = async (variantId: string, quantity: number) => {
    if (!session) {
      setLocalQty(variantId, quantity);
      return;
    }
    try {
      if (quantity <= 0) await del(`/carts/items/${variantId}`);
      else await patch(`/carts/items/${variantId}`, { quantity });
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const clear = async (slug: string, name: string) => {
    if (!window.confirm(`Remove everything from your ${name} basket?`)) return;
    if (!session) {
      clearLocal(slug);
      return;
    }
    try {
      await del(`/carts/${slug}`);
      await refresh();
      toast('Basket cleared');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <PageTitle title="Basket" back={false} sub={carts.length > 1 ? 'Each Nimpat store checks out separately.' : undefined} />
      {!ready && carts.length === 0 && <Loader />}
      {ready && carts.length === 0 && <Empty title="Your basket is empty" action={<Link className="btn primary" to="/">Start shopping</Link>} />}
      {carts.map((cart) => {
        const slug = cart.division?.slug ?? cart.division;
        const name = DIVISION_NAME[slug] ?? cart.division?.name ?? 'Basket';
        return (
          <div key={cart.cartId} className="basket-store">
            <section className="panel">
              <div className="panel-head">
                <h2>{name}</h2>
                <button className="text-link danger" onClick={() => void clear(slug, name)}><Trash2 size={15} aria-hidden="true" /> Clear</button>
              </div>
              {cart.lines.map((l: any) => (
                <div key={l.itemId} className="line">
                  <Link to={`/product/${l.productSlug}`} className="line-photo"><Photo src={l.image?.url ?? l.image} alt={l.productName} fit="contain" /></Link>
                  <div className="line-body">
                    <Link to={`/product/${l.productSlug}`}><b>{l.productName}</b></Link>
                    {l.variantName !== 'As listed' && <small>{l.variantName}</small>}
                    <span className="price">{formatNaira(l.lineTotalMinor)}</span>
                    {l.issues?.map((i: any) => <small key={String(i.code ?? i)} className="out">{ISSUE[String(i.code ?? i)] ?? String(i.message ?? i)}</small>)}
                  </div>
                  <div className="qty small">
                    <button aria-label={l.quantity === 1 ? `Remove ${l.productName}` : `Fewer ${l.productName}`} onClick={() => setQty(l.variantId, l.quantity - 1)}>{l.quantity === 1 ? <Trash2 size={15} /> : <Minus size={15} />}</button>
                    <span>{l.quantity}</span>
                    <button aria-label={`More ${l.productName}`} onClick={() => setQty(l.variantId, l.quantity + 1)}><Plus size={15} /></button>
                  </div>
                </div>
              ))}
            </section>
            {cart.local
              ? null
              : cart.canCheckout
              ? <CheckoutForm division={slug} version={cart.subtotalMinor} />
              : <Note tone="warn">Please fix the items marked above before you check out.</Note>}
          </div>
        );
      })}
      {!session && carts.length > 0 && <YourDetails onDone={() => void refresh()} />}
    </>
  );
}

/** Someone new gives their name, email and phone once, then checks out. No account or password needed. */
function YourDetails({ onDone }: { onDone: () => void }) {
  return (
    <>
      <DetailsForm onDone={onDone} />
      <p className="auth-switch">Have an account? <Link to="/login?next=/cart">Sign in</Link></p>
    </>
  );
}

const ISSUE: Record<string, string> = {
  UNAVAILABLE: 'No longer available',
  NOT_PURCHASABLE: 'Cannot be bought online',
  OUT_OF_STOCK: 'Out of stock',
  INSUFFICIENT_STOCK: 'Not enough in stock',
};

const OPTION_INFO: Record<string, { label: string; text: string; icon: any }> = {
  PAYSTACK: { label: 'Card, bank or USSD', text: 'Pay online with Paystack', icon: CreditCard },
  BANK_TRANSFER: { label: 'Bank transfer', text: 'We confirm once the money arrives', icon: Building },
  PAY_ON_DELIVERY: { label: 'Pay on delivery', text: 'Pay when your order arrives', icon: Truck },
  PAY_AT_LOCATION: { label: 'Pay in store', text: 'Pay when you collect', icon: Store },
};

/** Delivery, payment and total. It sits on the basket, so everything is on one page. */
function CheckoutForm({ division, version }: { division: string; version?: unknown }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useCart();
  const [fulfilment, setFulfilment] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [addressId, setAddressId] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [option, setOption] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotency());

  const addresses = useLoad(() => get('/me/addresses').then(rows), []);
  useEffect(() => {
    if (!addressId && addresses.data?.length) setAddressId((addresses.data.find((a: any) => a.isDefault) ?? addresses.data[0]).id);
    if (addresses.data && !addresses.data.length) setAdding(true);
  }, [addresses.data, addressId]);

  const removeAddress = async (a: any) => {
    if (!window.confirm(`Remove ${a.label ?? a.line1}?`)) return;
    try {
      await del(`/me/addresses/${a.id}`);
      if (addressId === a.id) setAddressId('');
      await addresses.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const needsAddress = fulfilment === 'DELIVERY';
  const query = `fulfilmentType=${fulfilment}${needsAddress && addressId ? `&addressId=${addressId}` : ''}`;
  const ready = !needsAddress || !!addressId;
  const quote = useLoad(() => (ready ? get(`/carts/${division}/quote?${query}`) : Promise.resolve(null)), [division, query, ready, version]);
  const options = useLoad(() => (ready ? get(`/orders/checkout-options?division=${division}&${query}`) : Promise.resolve(null)), [division, query, ready, version]);
  const all: any[] = options.data?.options ?? [];
  const available = all.filter((o) => o.available);
  useEffect(() => {
    if (available.length && !available.some((o) => o.option === option)) setOption(available[0].option);
    if (!available.length) setOption('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.data]);

  const place = async () => {
    if (!quote.data) return;
    setBusy(true);
    try {
      const order = await post('/orders', {
        division,
        fulfilmentType: fulfilment,
        ...(needsAddress ? { addressId } : {}),
        paymentOption: option,
        expectedTotalMinor: quote.data.totalMinor,
        ...(note.trim() ? { customerNote: note.trim() } : {}),
      }, key.current);
      await refresh();
      if (option === 'PAYSTACK' || option === 'BANK_TRANSFER') navigate(`/pay/ORDER/${order.id}?method=${option}`);
      else {
        toast(`Order ${order.orderNumber} placed`);
        navigate('/bookings?tab=orders');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
      key.current = idempotency();
      void quote.reload();
    } finally {
      setBusy(false);
    }
  };

  const q = quote.data;
  return (
    <>
      <section className="panel">
        <h2>Delivery</h2>
        <div className="segmented" role="group" aria-label="Delivery or collection">
          <button className={fulfilment === 'DELIVERY' ? 'on' : ''} onClick={() => setFulfilment('DELIVERY')}><Truck size={16} aria-hidden="true" /> Deliver</button>
          <button className={fulfilment === 'PICKUP' ? 'on' : ''} onClick={() => setFulfilment('PICKUP')}><Store size={16} aria-hidden="true" /> Pick up</button>
        </div>
        {needsAddress && (
          <>
            {addresses.data?.map((a: any) => (editing?.id === a.id
              ? <AddressForm key={a.id} address={a} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await addresses.reload(); void quote.reload(); }} />
              : (
                <div key={a.id} className="choice-row">
                  <label className={`choice ${addressId === a.id ? 'on' : ''}`}>
                    <input type="radio" name={`address-${division}`} checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                    <MapPin size={18} aria-hidden="true" />
                    <span><b>{a.label ?? a.recipientName}</b><small>{addressLine(a)}</small></span>
                  </label>
                  <button type="button" className="icon-btn" aria-label={`Edit ${a.label ?? a.line1}`} onClick={() => setEditing(a)}><Pencil size={16} /></button>
                  <button type="button" className="icon-btn" aria-label={`Remove ${a.label ?? a.line1}`} onClick={() => removeAddress(a)}><Trash2 size={16} /></button>
                </div>
              )))}
            {adding
              ? <AddressForm onCancel={addresses.data?.length ? () => setAdding(false) : undefined} onSaved={async (a) => { await addresses.reload(); setAddressId(a.id); setAdding(false); }} />
              : <button className="btn ghost full" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> Add an address</button>}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Payment</h2>
        {!ready && <p className="muted-text">Add your address to see your choices.</p>}
        {options.loading && !options.data && ready && <Loader />}
        {options.error && <Note tone="error">{options.error}</Note>}
        {all.map((o) => {
          const info = OPTION_INFO[o.option];
          if (!info) return null;
          const Icon = info.icon;
          return (
            <label key={o.option} className={`choice ${option === o.option ? 'on' : ''} ${o.available ? '' : 'off'}`}>
              <input type="radio" name={`payment-${division}`} disabled={!o.available} checked={option === o.option} onChange={() => setOption(o.option)} />
              <Icon size={18} aria-hidden="true" />
              <span><b>{info.label}</b><small>{o.available ? info.text : o.reason ?? 'Not available yet'}</small></span>
            </label>
          );
        })}
        <Field label="Note (optional)"><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </section>

      <section className="panel">
        {quote.error && <Note tone="warn">{quote.error}</Note>}
        {q && (
          <>
            <div className="sum"><span>Items</span><span>{formatNaira(q.subtotalMinor)}</span></div>
            {needsAddress && <div className="sum"><span>Delivery</span><span>{q.deliveryFeeMinor === null || q.deliveryFeeMinor === undefined ? 'To be confirmed' : formatNaira(q.deliveryFeeMinor)}</span></div>}
            {!needsAddress && <div className="sum"><span>Delivery</span><span>Free (pick up)</span></div>}
            <div className="sum total"><span>Total</span><b>{formatNaira(q.totalMinor)}</b></div>
            <small className="muted-text">No extra tax is added. The total is what you pay.</small>
          </>
        )}
        <button className="btn primary full" disabled={busy || !q || !option || !ready || q.canCheckout === false} onClick={place}>{busy ? 'Placing your order…' : 'Place order'}</button>
      </section>
    </>
  );
}

export function CheckoutPage() {
  const { division = '' } = useParams();
  return (
    <>
      <PageTitle title="Checkout" sub={DIVISION_NAME[division]} />
      <CheckoutForm division={division} />
    </>
  );
}

/** Choose how to pay for any order or booking, and follow a bank transfer through. */
export function PayPage() {
  const { purpose = '', id = '' } = useParams();
  const [params] = useSearchParams();
  const toast = useToast();
  const navigate = useNavigate();
  const options = useLoad(() => get(`/payments/options?purpose=${purpose}&payableId=${id}`), [purpose, id]);
  const [amount, setAmount] = useState<'BALANCE' | 'DEPOSIT'>('BALANCE');
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<any>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const started = useRef(false);

  const pay = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNeedsVerify(false);
    try {
      await fn();
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 403 && /verif/i.test(err.message)) setNeedsVerify(true);
      else if (/payment provider/i.test(err.message)) toast('Online payment is not available right now. Please try bank transfer or call us.', 'error');
      else toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const paystack = () => pay(async () => {
    const r = await post('/payments/initialize', { purpose, payableId: id, amountOption: amount }, idempotency());
    await openPayment(r.authorizationUrl, r.reference);
  });
  const bank = () => pay(async () => setTransfer(await post('/payments/bank-transfer', { purpose, payableId: id, amountOption: amount }, idempotency())));

  const o = options.data;
  // Coming straight from checkout with bank transfer chosen: go to the account details.
  useEffect(() => {
    if (o && params.get('method') === 'BANK_TRANSFER' && o.methods.bankTransfer.available && !started.current) {
      started.current = true;
      void bank();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o]);

  if (options.loading && !o) return <Loader />;
  if (options.error) return <><PageTitle title="Payment" /><Note tone="error">{options.error}</Note></>;
  if (!o) return null;
  if (transfer) return <TransferSteps transfer={transfer} onDone={() => navigate('/bookings', { replace: true })} />;

  const canChooseDeposit = o.depositOutstandingMinor > 0 && o.depositOutstandingMinor < o.outstandingMinor;
  const nothingOpen = !o.methods.paystack.available && !o.methods.bankTransfer.available && !o.methods.payAtLocation.available;
  return (
    <>
      <PageTitle title="Payment" sub={o.label} />
      <section className="panel">
        <div className="sum"><span>Total</span><span>{formatNaira(o.totalDueMinor)}</span></div>
        {o.paidMinor > 0 && <div className="sum"><span>Paid</span><span>{formatNaira(o.paidMinor)}</span></div>}
        {o.awaitingVerificationMinor > 0 && <div className="sum"><span>Being checked by finance</span><span>{formatNaira(o.awaitingVerificationMinor)}</span></div>}
        <div className="sum total"><span>Still to pay</span><b>{formatNaira(o.outstandingMinor)}</b></div>
        {o.payBy && <p className="muted-text"><Clock size={14} aria-hidden="true" /> Please pay by {dateTime(o.payBy)}</p>}
        <Status value={o.paymentStatus} />
      </section>
      {o.delivery && <DeliverTo orderId={id} delivery={o.delivery} onChanged={() => void options.reload()} />}
      {o.closedReason && <Note tone="warn">{o.closedReason}</Note>}
      {needsVerify && <VerifyEmailNote />}
      {canChooseDeposit && (
        <section className="panel">
          <h2>How much?</h2>
          <div className="segmented" role="group" aria-label="Amount">
            <button className={amount === 'DEPOSIT' ? 'on' : ''} onClick={() => setAmount('DEPOSIT')}>Deposit {formatNaira(o.depositOutstandingMinor)}</button>
            <button className={amount === 'BALANCE' ? 'on' : ''} onClick={() => setAmount('BALANCE')}>Full {formatNaira(o.outstandingMinor)}</button>
          </div>
        </section>
      )}
      <section className="panel">
        <h2>Choose how to pay</h2>
        {o.methods.paystack.available && (
          <button className="pay-option" disabled={busy} onClick={paystack}>
            <CreditCard size={20} aria-hidden="true" />
            <span><b>Pay online</b><small>{o.methods.paystack.note}</small></span>
          </button>
        )}
        {o.methods.bankTransfer.available && (
          <button className="pay-option" disabled={busy} onClick={bank}>
            <Building size={20} aria-hidden="true" />
            <span><b>Bank transfer</b><small>Confirmed once our finance team sees the money. Allow up to {o.methods.bankTransfer.windowHours} hours to pay.</small></span>
          </button>
        )}
        {o.methods.payAtLocation.available && o.methods.payAtLocation.locations.map((l: any) => (
          <div key={l.id} className="pay-option static"><Banknote size={20} aria-hidden="true" /><span><b>Pay at {l.name}</b><small>{[l.addressLine, l.city].filter(Boolean).join(', ')}</small></span></div>
        ))}
        {nothingOpen && !o.closedReason && <Note>Online payment is not open for this yet. Please call us and we will help you pay.</Note>}
        <CallLink />
      </section>
    </>
  );
}

/** Where an order is going, with a way to fix a wrong address before it is paid or sent out. */
function DeliverTo({ orderId, delivery, onChanged }: { orderId: string; delivery: { address: any; feeMinor: number; canChangeAddress: boolean }; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const addresses = useLoad(() => (open ? get('/me/addresses').then(rows) : Promise.resolve([])), [open]);
  const choose = async (addressId: string) => {
    setBusy(true);
    try {
      await patch(`/orders/${orderId}/address`, { addressId });
      toast('Address changed. The delivery fee has been updated.');
      setOpen(false);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Delivering to</h2>
        {delivery.canChangeAddress && <button className="text-link" onClick={() => setOpen(true)}>Change</button>}
      </div>
      <div className="address-row">
        <MapPin size={18} aria-hidden="true" />
        <span><b>{delivery.address?.recipientName}</b><small>{delivery.address ? addressLine(delivery.address) : ''}</small></span>
      </div>
      <div className="sum"><span>Delivery fee</span><span>{formatNaira(delivery.feeMinor)}</span></div>
      {!delivery.canChangeAddress && <p className="muted-text">To change the address now, please call us.</p>}
      {open && (
        <Sheet title="Deliver to another address" onClose={() => setOpen(false)}>
          {addresses.loading && <Loader />}
          {(addresses.data ?? []).map((a: any) => (
            <button key={a.id} className="pay-option" disabled={busy} onClick={() => void choose(a.id)}>
              <MapPin size={20} aria-hidden="true" />
              <span><b>{a.label ?? a.recipientName}</b><small>{addressLine(a)}</small></span>
            </button>
          ))}
          {adding ? (
            <AddressForm onCancel={() => setAdding(false)} onSaved={async (a) => { setAdding(false); await addresses.reload(); if (a?.id) await choose(a.id); }} />
          ) : (
            <button className="btn ghost full" onClick={() => setAdding(true)}>Add a new address</button>
          )}
        </Sheet>
      )}
    </section>
  );
}

function TransferSteps({ transfer, onDone }: { transfer: any; onDone: () => void }) {
  const toast = useToast();
  const [payerName, setPayerName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(transfer.status === 'AWAITING_VERIFICATION');
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Please copy it by hand', 'error');
    }
  };
  const notify = async () => {
    setBusy(true);
    try {
      await post(`/payments/bank-transfer/${transfer.reference}/notify`, { payerName: payerName.trim() });
      if (file) {
        const form = new FormData();
        form.append('file', file);
        await api(`/payments/bank-transfer/${transfer.reference}/proofs`, { method: 'POST', body: form });
      }
      setSent(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (sent) {
    return (
      <>
        <PageTitle title="Thank you" back={false} />
        <section className="panel center">
          <span className="done-mark"><Check size={28} aria-hidden="true" /></span>
          <h2>We have your note</h2>
          <p>This is not confirmed yet. Our finance team will check that the money has reached our account, then confirm it here.</p>
          <p className="muted-text">Reference {transfer.reference}</p>
          <button className="btn primary full" onClick={onDone}>See my orders and bookings</button>
        </section>
      </>
    );
  }
  return (
    <>
      <PageTitle title="Bank transfer" />
      <section className="panel">
        <h2>Send exactly {formatNaira(transfer.amountMinor)}</h2>
        {transfer.payBy && <p className="muted-text"><Clock size={14} aria-hidden="true" /> Please pay by {dateTime(transfer.payBy)}</p>}
        <dl className="facts">
          <div><dt>Bank</dt><dd>{transfer.account?.bankName}</dd></div>
          <div><dt>Account name</dt><dd>{transfer.account?.accountName}</dd></div>
          <div><dt>Account number</dt><dd><button className="copy" onClick={() => copy(transfer.account?.accountNumber)}>{transfer.account?.accountNumber}</button></dd></div>
          <div><dt>Narration</dt><dd><button className="copy" onClick={() => copy(transfer.reference)}>{transfer.reference}</button></dd></div>
        </dl>
        <Note>Use this reference as the narration so we can find your payment quickly. Only pay into the account shown here.</Note>
      </section>
      <section className="panel">
        <h2>After you have paid</h2>
        <Field label="Name on the paying account"><input value={payerName} onChange={(e) => setPayerName(e.target.value)} autoComplete="name" /></Field>
        <label className="file-pick">
          <Upload size={16} aria-hidden="true" /> {file ? file.name : 'Add your receipt (optional)'}
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn primary full" disabled={busy || payerName.trim().length < 2} onClick={notify}>{busy ? 'Sending…' : 'I have paid'}</button>
      </section>
    </>
  );
}

/** Paystack brings the customer back here. Only the API's own check with Paystack counts. */
export function PaymentCallbackPage() {
  const [params] = useSearchParams();
  const reference = params.get('reference') ?? params.get('trxref') ?? '';
  const result = useLoad(() => (reference ? post(`/payments/verify/${encodeURIComponent(reference)}`) : Promise.reject(new Error('This payment link has no reference.'))), [reference]);
  const status = result.data?.status;
  if (result.loading) return <Loader label="Checking your payment" />;
  const ok = status === 'SUCCESS';
  return (
    <>
      <PageTitle title={ok ? 'Payment received' : 'Payment not complete'} back={false} />
      <section className="panel center">
        {ok && <span className="done-mark"><Check size={28} aria-hidden="true" /></span>}
        {ok && <p>Thank you. Your payment of {formatNaira(result.data.amountMinor)} has been confirmed.</p>}
        {!ok && <Note tone={result.error ? 'error' : 'warn'}>{result.error ?? 'We have not received this payment. If money left your account, please call us with your reference and we will check.'}</Note>}
        {reference && <p className="muted-text">Reference {reference}</p>}
        <Link className="btn primary full" to="/bookings">See my orders and bookings</Link>
        {!ok && <CallLink />}
      </section>
    </>
  );
}

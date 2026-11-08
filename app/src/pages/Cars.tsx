import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, HandCoins, KeyRound, Truck, Wrench } from 'lucide-react';
import { formatNaira, get, getSession, post, rows } from '../api';
import { useDetailsFirst } from './Account';
import { CallLink, Empty, FavButton, Field, Loader, Note, PageTitle, Photo, useLoad, useToast } from '../ui';

const CONDITION: Record<string, string> = { BRAND_NEW: 'Brand new', FOREIGN_USED: 'Foreign used', NIGERIAN_USED: 'Nigerian used', CERTIFIED_PRE_OWNED: 'Certified pre-owned' };
const INQUIRY = [
  ['GENERAL', 'Ask a question'],
  ['TEST_DRIVE', 'Book a test drive'],
  ['INSPECTION', 'Book an inspection'],
  ['DEPOSIT_HOLD', 'Hold with a deposit'],
  ['FINANCING', 'Ask about financing'],
  ['HIRE_PURCHASE', 'Buy on hire purchase'],
] as const;

const carName = (v: any) => `${v.year} ${v.make} ${v.model}`;

export function CarsPage() {
  const cars = useLoad(() => get('/vehicles?pageSize=100').then(rows));
  const [make, setMake] = useState('');
  const [text, setText] = useState('');
  const makes = useMemo(() => [...new Set((cars.data ?? []).map((v: any) => v.make))].sort() as string[], [cars.data]);
  const q = text.trim().toLowerCase();
  const shown = (cars.data ?? []).filter((v: any) => (!make || v.make === make) && (!q || carName(v).toLowerCase().includes(q)));
  return (
    <>
      <PageTitle title="Cars" sub="Buy, hire, pay over time, or move anything." />
      <div className="action-grid">
        <Link to="/services/automobiles?category=Car hire" className="action-card green"><KeyRound size={22} aria-hidden="true" /><span><b>Hire a car</b><small>With or without a driver</small></span></Link>
        <Link to="/services/automobiles?category=Hire purchase" className="action-card teal"><HandCoins size={22} aria-hidden="true" /><span><b>Hire purchase</b><small>Drive now, pay over time</small></span></Link>
        <Link to="/services/automobiles" className="action-card green"><Wrench size={22} aria-hidden="true" /><span><b>Car care</b><small>Servicing, repairs, inspection</small></span></Link>
        <Link to="/services/transport-logistics" className="action-card teal"><Truck size={22} aria-hidden="true" /><span><b>Logistics</b><small>Parcels, haulage, moving</small></span></Link>
      </div>
      <h2 className="group-title">Cars for sale</h2>
      <div className="search-box"><input aria-label="Search cars" placeholder="Search make, model or year" value={text} onChange={(e) => setText(e.target.value)} /></div>
      {makes.length > 1 && (
        <div className="chips" role="group" aria-label="Make">
          <button className={!make ? 'on' : ''} onClick={() => setMake('')}>All</button>
          {makes.map((m) => <button key={m} className={make === m ? 'on' : ''} onClick={() => setMake(m)}>{m}</button>)}
        </div>
      )}
      {cars.loading && !cars.data && <Loader />}
      {cars.error && <Note tone="error">{cars.error}</Note>}
      {cars.data && shown.length === 0 && <Empty title={q || make ? 'No car matches that' : 'Coming soon'}>{q || make ? 'Try another search.' : 'Our team is confirming the cars on show.'}</Empty>}
      <div className="grid wide">
        {shown.map((v: any) => (
          <Link key={v.id} to={`/cars/${v.slug}`} className="card stay">
            <FavButton kind="VEHICLE" slug={v.slug} />
            <div className="card-photo"><Photo src={v.images?.[0]?.url} alt={carName(v)} /></div>
            <div className="card-body">
              <strong>{carName(v)}</strong>
              <small>{[v.trim, CONDITION[v.condition], v.transmission?.toLowerCase()].filter(Boolean).join(' · ')}</small>
              <span className={v.priceMinor === null ? 'price muted' : 'price'}>{v.priceMinor === null ? 'Contact for price' : formatNaira(v.priceMinor)}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function CarPage() {
  const { slug = '' } = useParams();
  const car = useLoad(() => get(`/vehicles/${slug}`), [slug]);
  const [photo, setPhoto] = useState(0);
  const v = car.data;
  if (car.loading && !v) return <Loader />;
  if (!v) return <><PageTitle title="Not available" /><Empty title="This car is not available right now" /></>;
  const facts: [string, unknown][] = [
    ['Condition', CONDITION[v.condition] ?? v.condition],
    ['Body', v.bodyType],
    ['Transmission', v.transmission],
    ['Fuel', v.fuelType],
    ['Colour', v.colour],
    ['Mileage', v.mileageKm !== null && v.mileageKm !== undefined ? `${Number(v.mileageKm).toLocaleString('en-NG')} km` : null],
    ['Customs', v.customsCleared ? 'Cleared' : null],
    ...(v.specs && typeof v.specs === 'object' && !Array.isArray(v.specs) ? (Object.entries(v.specs).filter(([, x]) => typeof x === 'string' || typeof x === 'number') as [string, unknown][]) : []),
  ];
  const main = v.images?.[photo] ?? v.images?.[0];
  return (
    <article className="detail">
      <PageTitle title={carName(v)} sub={v.trim} action={<FavButton kind="VEHICLE" slug={v.slug} inline />} />
      <div className="detail-grid">
        <div>
          <div className="stay-photo"><Photo src={main?.url} alt={carName(v)} /></div>
          {v.images?.length > 1 && <div className="thumbs wide">{v.images.map((i: any, n: number) => <button key={i.id ?? n} className={n === photo ? 'on' : ''} aria-label={`Photo ${n + 1}`} onClick={() => setPhoto(n)}><img src={i.url} alt="" loading="lazy" /></button>)}</div>}
        </div>
        <div className="detail-side">
          <p className="big-price">{v.priceMinor === null ? 'Contact for price' : formatNaira(v.priceMinor)}</p>
          {v.status && v.status !== 'AVAILABLE' && <Note tone="warn">This car is currently {String(v.status).toLowerCase().replace(/_/g, ' ')}.</Note>}
          <dl className="facts">{facts.filter(([, x]) => x !== null && x !== undefined && x !== '').map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{String(x).replace(/_/g, ' ')}</dd></div>)}</dl>
          {v.description && <p>{v.description}</p>}
          <Inquiry vehicle={v} />
        </div>
      </div>
    </article>
  );
}

function Inquiry({ vehicle }: { vehicle: any }) {
  const session = getSession();
  const toast = useToast();
  const [type, setType] = useState<string>('GENERAL');
  const [name, setName] = useState(session?.firstName ?? '');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const details = useDetailsFirst();
  useEffect(() => {
    if (!session) return;
    get('/auth/me').then((me) => {
      if (me?.customerProfile) setName([me.customerProfile.firstName, me.customerProfile.lastName].filter(Boolean).join(' '));
      if (me?.phone) setPhone(me.phone);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wantsDate = type === 'TEST_DRIVE' || type === 'INSPECTION';
  const send = async () => {
    setBusy(true);
    try {
      await post(`/vehicles/${vehicle.id}/inquiries`, {
        type, contactName: name.trim(), contactEmail: session!.email, contactPhone: phone.trim(),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(wantsDate && date ? { preferredDate: new Date(date).toISOString() } : {}),
      });
      setSent(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (sent) return <section className="panel center"><span className="done-mark"><Check size={28} aria-hidden="true" /></span><h2>Thank you</h2><p>Our automobiles team will call you shortly.</p></section>;
  return (
    <section className="panel">
      <h2>Talk to our team</h2>
      {!session ? (
        <>
          <p>Tell us who you are so we can reply, or call us now.</p>
          <button className="btn primary full" onClick={() => details.ask(() => undefined)}>Continue</button>
          {details.sheet}
        </>
      ) : (
        <>
          <Field label="What would you like?"><select value={type} onChange={(e) => setType(e.target.value)}>{INQUIRY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {type === 'DEPOSIT_HOLD' && <Note>Our team will confirm the deposit with you before you pay anything.</Note>}
          <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          <Field label="Phone number" hint="E.g. 0803 123 4567, or +44… if abroad"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>
          {wantsDate && <Field label="Preferred date and time"><input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
          <Field label="Message (optional)"><textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
          <button className="btn primary full" disabled={busy || name.trim().length < 2 || phone.trim().length < 7} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        </>
      )}
      <CallLink />
    </section>
  );
}

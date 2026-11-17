import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MapPin, Minus, Plus } from 'lucide-react';
import { formatNaira, get, idempotency, post, rows } from '../api';
import { useDetailsFirst, WhereChooser } from './Account';
import { CallLink, Empty, FavButton, Field, lagosDate, Loader, Note, PageTitle, Photo, PhotoGallery, Sheet, spaImage, useLoad, useToast } from '../ui';
import { pharmacyAllowed } from '../platform';

export function SpaPage() {
  const list = useLoad(() => get('/spa/treatments?pageSize=100').then(rows));
  // ?category=Spa packages opens the page on that category (used by the home slider card).
  const [params] = useSearchParams();
  const [category, setCategory] = useState(params.get('category') ?? '');
  const cats = useMemo(() => [...new Set((list.data ?? []).map((t: any) => t.category).filter(Boolean))] as string[], [list.data]);
  useEffect(() => {
    if (!list.data || !category) return;
    const match = cats.find((c) => c.toLowerCase() === category.toLowerCase());
    if (match !== category) setCategory(match ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);
  const shown = (list.data ?? []).filter((t: any) => !category || t.category === category);
  return (
    <>
      <PageTitle title="Spa" sub="A little time for you." />
      {cats.length > 1 && (
        <div className="chips" role="group" aria-label="Category">
          <button className={!category ? 'on' : ''} onClick={() => setCategory('')}>All</button>
          {cats.map((c) => <button key={c} className={category === c ? 'on' : ''} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}
      {list.loading && !list.data && <Loader />}
      {list.error && <Note tone="error">{list.error}</Note>}
      {list.data && shown.length === 0 && <Empty title="Coming soon">Our spa team is confirming treatments and prices.</Empty>}
      <div className="grid wide">
        {shown.map((t: any) => (
          <Link key={t.id} to={`/spa/${t.slug}`} className="card stay">
            <FavButton kind="TREATMENT" slug={t.slug} />
            <div className="card-photo"><Photo src={spaImage(t)} alt={t.name} /></div>
            <div className="card-body">
              <strong>{t.name}</strong>
              {t.homeService && <small>At home too</small>}
              <span className={t.priceMinor === null ? 'price muted' : 'price'}>{t.priceMinor === null ? 'Contact for price' : formatNaira(t.priceMinor)}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function TreatmentPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const treatment = useLoad(() => get(`/spa/treatments/${slug}`), [slug]);
  const t = treatment.data;
  const [date, setDate] = useState(lagosDate(1));
  const [slot, setSlot] = useState<any>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [atHome, setAtHome] = useState(false);
  const [addressId, setAddressId] = useState('');
  const details = useDetailsFirst();
  const slots = useLoad(() => (t ? get(`/spa/treatments/${t.id}/slots?date=${date}`).then((r) => r.slots ?? []) : Promise.resolve([])), [t?.id, date]);
  useEffect(() => setSlot(null), [date]);
  if (treatment.loading && !t) return <Loader />;
  if (!t) return <><PageTitle title="Not available" /><Empty title="This treatment is not available right now" /></>;
  const book = async () => {
    setBusy(true);
    try {
      await post('/spa/appointments', { treatmentId: t.id, startsAt: slot.startsAt, ...(note.trim() ? { customerNote: note.trim() } : {}), ...(atHome ? { atHome: true, addressId } : {}) }, idempotency());
      toast(`Request sent for ${t.name}. The spa will confirm your time with you.`);
      navigate('/bookings?tab=spa');
    } catch (e) {
      toast((e as Error).message, 'error');
      void slots.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="detail">
      <PageTitle title={t.name} sub={t.category} action={<FavButton kind="TREATMENT" slug={t.slug} inline />} />
      <div className="detail-grid media">
        <PhotoGallery photos={spaImage(t) ? [{ url: spaImage(t)! }] : []} alt={t.name} />
        <div className="detail-side">
          <p className="big-price">{t.priceMinor === null ? 'Contact for price' : formatNaira(t.priceMinor)}</p>
          {t.depositMinor > 0 && <p className="muted-text">Deposit {formatNaira(t.depositMinor)}.</p>}
          {t.description && <p>{t.description}</p>}
          {t.homeService && <p className="muted-text"><MapPin size={14} aria-hidden="true" /> Also available at your home{t.homeFeeMinor ? ` for ${formatNaira(t.homeFeeMinor)} more` : ''}.</p>}
          <section className="panel">
            {t.homeService && (
              <>
                <h2>Where</h2>
                <WhereChooser mode="EITHER" feeMinor={t.homeFeeMinor} venue="At the spa" atHome={atHome} setAtHome={setAtHome} addressId={addressId} setAddressId={setAddressId} />
              </>
            )}
            <h2>Choose a time</h2>
            <Field label="Date"><input type="date" min={lagosDate()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            {slots.loading && <Loader label="Finding times" />}
            {!slots.loading && (slots.data?.length ?? 0) === 0 && <Note>The spa is closed for the rest of this day. Please choose another date.</Note>}
            <div className="slots">
              {(slots.data ?? []).map((s: any) => (
                <button key={s.startsAt} className={slot?.startsAt === s.startsAt ? 'on' : ''} onClick={() => setSlot(s)}>
                  {new Date(s.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}
                </button>
              ))}
            </div>
            {slot && (
              <>
                <Field label="Anything we should know? (optional)"><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <button className="btn primary full" disabled={busy || (atHome && !addressId)} onClick={() => details.ask(() => void book())}>{busy ? 'Sending…' : 'Send booking request'}</button>
                <small className="muted-text">The spa confirms your time with you. You can pay online from your bookings, or at the spa.</small>
                {details.sheet}
              </>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}

const SERVICE_TITLE: Record<string, { title: string; sub: string }> = {
  'pharmacy-laboratory': { title: 'Pharmacist & laboratory', sub: 'Lab tests, consultations and sample collection at home.' },
  'spa-wellness': { title: 'Spa services', sub: 'Packages and home services.' },
  'media-events-rentals': { title: 'Media, events & rentals', sub: 'Tell us about your event and we will help.' },
  'real-estate-interior-design': { title: 'Property & interiors', sub: 'Real estate and interior design.' },
  entertainment: { title: 'Entertainment', sub: 'Book something to enjoy.' },
  'transport-logistics': { title: 'Logistics', sub: 'Parcels, haulage, moving and transport.' },
  automobiles: { title: 'Car hire & car care', sub: 'Hire a car, buy on hire purchase, or book servicing.' },
};

const priceText = (s: any) =>
  s.basePriceMinor === null ? 'We confirm the price with you' : `${s.pricingType === 'STARTING_FROM' ? 'From ' : ''}${formatNaira(s.basePriceMinor)}`;

export function ServicesPage() {
  const { division = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const hidden = !pharmacyAllowed(division);
  const info = SERVICE_TITLE[division] ?? { title: 'Services', sub: '' };
  const list = useLoad(() => (hidden ? Promise.resolve([]) : get(`/services?division=${division}`).then(rows)), [division]);
  const [picked, setPicked] = useState<any>(null);
  const cats = useMemo(() => [...new Set((list.data ?? []).map((s: any) => s.category).filter(Boolean))] as string[], [list.data]);
  const wanted = params.get('category') ?? '';
  const category = cats.find((c) => c.toLowerCase() === wanted.toLowerCase()) ?? '';
  const choose = (c: string) => setParams(c ? { category: c } : {}, { replace: true });
  const shown = (list.data ?? []).filter((s: any) => !category || s.category === category);
  if (hidden) return <Navigate to="/" replace />;
  return (
    <>
      <PageTitle title={category || info.title} sub={category ? info.title : info.sub} />
      {cats.length > 1 && (
        <div className="chips" role="group" aria-label="Kind of service">
          <button className={!category ? 'on' : ''} onClick={() => choose('')}>All</button>
          {cats.map((c) => <button key={c} className={category === c ? 'on' : ''} onClick={() => choose(c)}>{c}</button>)}
        </div>
      )}
      {list.loading && !list.data && <Loader />}
      {list.error && <Note tone="error">{list.error}</Note>}
      {list.data && shown.length === 0 && <Empty title="Coming soon" action={<CallLink />}>Our team is getting this ready. In the meantime, please call us.</Empty>}
      <div className="list">
        {shown.map((s: any) => (
          <article key={s.id} className="service">
            {s.imageUrl && <div className="service-photo"><Photo src={s.imageUrl} alt={s.name} /></div>}
            <div className="service-body">
              <h2>{s.name}</h2>
              {s.description && <p>{s.description}</p>}
              <span className={s.basePriceMinor === null ? 'price muted' : 'price'}>{priceText(s)}</span>
              <div className="service-tags">
                {!category && s.category && <span>{s.category}</span>}
                {s.serviceMode === 'AT_HOME' && <span>We come to you</span>}
                {s.serviceMode === 'EITHER' && <span>At home or with us</span>}
              </div>
            </div>
            <button className="btn primary" onClick={() => setPicked(s)}>Book</button>
          </article>
        ))}
      </div>
      {picked && <ServiceSheet service={picked} onClose={() => setPicked(null)} />}
    </>
  );
}

/** Car hire is booked for a length of time: from pick-up until the car comes back. */
const isHire = (s: any) => /car hire/i.test(`${s.category ?? ''} ${s.name ?? ''}`);
/** Now, as a date-time picker value on this device (so past times cannot be picked). */
const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

type HireUnit = 'hours' | 'days' | 'weeks';
const HIRE_UNITS: { unit: HireUnit; label: string; hours: number; max: number }[] = [
  { unit: 'hours', label: 'Hours', hours: 1, max: 24 },
  { unit: 'days', label: 'Days', hours: 24, max: 90 },
  { unit: 'weeks', label: 'Weeks', hours: 168, max: 12 },
];
const hireWords = (n: number, unit: HireUnit) => `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
/** "Sat 21 Nov, 10:00", in the same time as the picker the customer used. */
const longWhen = (d: Date) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** How long the car is needed: a number and hours, days or weeks, with the return time worked out. */
function HireLength({ start, length, unit, setLength, setUnit }: { start: string; length: number; unit: HireUnit; setLength: (n: number) => void; setUnit: (u: HireUnit) => void }) {
  const u = HIRE_UNITS.find((x) => x.unit === unit)!;
  const back = start ? new Date(new Date(start).getTime() + length * u.hours * 3_600_000) : null;
  return (
    <div className="hire-length">
      <span className="buy-label">How long do you need it?</span>
      <div className="hire-row">
        <div className="qty">
          <button type="button" aria-label="Shorter" disabled={length <= 1} onClick={() => setLength(length - 1)}><Minus size={16} /></button>
          <span aria-live="polite">{length}</span>
          <button type="button" aria-label="Longer" disabled={length >= u.max} onClick={() => setLength(length + 1)}><Plus size={16} /></button>
        </div>
        <div className="segmented" role="group" aria-label="Hours, days or weeks">
          {HIRE_UNITS.map((x) => <button key={x.unit} type="button" className={unit === x.unit ? 'on' : ''} onClick={() => { setUnit(x.unit); setLength(Math.min(length, x.max)); }}>{x.label}</button>)}
        </div>
      </div>
      <p className="hire-back">{back ? <>Return by <b>{longWhen(back)}</b> · {hireWords(length, unit)}</> : <>Choose the pick-up date and time to see when the car is due back.</>}</p>
    </div>
  );
}

function ServiceSheet({ service, onClose }: { service: any; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [atHome, setAtHome] = useState(service.serviceMode === 'AT_HOME');
  const [addressId, setAddressId] = useState('');
  const [busy, setBusy] = useState(false);
  const hire = isHire(service);
  const [length, setLength] = useState(1);
  const [unit, setUnit] = useState<HireUnit>(/wedding|event/i.test(service.name ?? '') ? 'hours' : 'days');
  const details = useDetailsFirst();
  const home = service.serviceMode === 'AT_HOME' || (service.serviceMode === 'EITHER' && atHome);
  const send = async () => {
    setBusy(true);
    try {
      const start = when ? new Date(when) : null;
      const hours = length * HIRE_UNITS.find((x) => x.unit === unit)!.hours;
      await post('/services/bookings', {
        offeringId: service.id,
        ...(start ? { scheduledStart: start.toISOString() } : {}),
        ...(hire && start ? { scheduledEnd: new Date(start.getTime() + hours * 3_600_000).toISOString(), details: { 'Hire for': hireWords(length, unit) } } : {}),
        ...(note.trim() ? { customerNote: note.trim() } : {}),
        ...(home ? { atHome: true, addressId } : {}),
      }, idempotency());
      toast('Request sent. We will confirm with you soon.');
      navigate('/bookings?tab=services');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={service.name} onClose={onClose}>
      <WhereChooser mode={service.serviceMode ?? 'AT_VENUE'} feeMinor={service.homeFeeMinor} venue="At our place" atHome={atHome} setAtHome={setAtHome} addressId={addressId} setAddressId={setAddressId} />
      {hire ? (
        <>
          <Field label="Pick-up date and time"><input type="datetime-local" min={nowLocal()} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <HireLength start={when} length={length} unit={unit} setLength={setLength} setUnit={setUnit} />
        </>
      ) : (
        <Field label="Preferred date and time (optional)"><input type="datetime-local" min={nowLocal()} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      )}
      <Field label={hire ? 'Anything else? (optional)' : 'Tell us what you need (optional)'}><textarea rows={3} maxLength={1000} placeholder={hire ? 'e.g. the car you would like, pick-up place, trip destination' : undefined} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <button className="btn primary full" disabled={busy || (home && !addressId) || (hire && !when)} onClick={() => details.ask(() => void send())}>{busy ? 'Sending…' : 'Send request'}</button>
      {details.sheet}
      <small className="muted-text">Our team confirms the time and any price before you pay.</small>
    </Sheet>
  );
}

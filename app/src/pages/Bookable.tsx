import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Clock, MapPin } from 'lucide-react';
import { formatNaira, get, idempotency, post, rows } from '../api';
import { useDetailsFirst, WhereChooser } from './Account';
import { CallLink, Empty, FavButton, Field, lagosDate, Loader, Note, PageTitle, Photo, PhotoGallery, Sheet, spaImage, useLoad, useToast } from '../ui';

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
              <small><Clock size={13} aria-hidden="true" /> {t.durationMinutes} minutes{t.homeService ? ' · at home too' : ''}</small>
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
      const a = await post('/spa/appointments', { treatmentId: t.id, startsAt: slot.startsAt, ...(note.trim() ? { customerNote: note.trim() } : {}), ...(atHome ? { atHome: true, addressId } : {}) }, idempotency());
      navigate(`/pay/SPA_APPOINTMENT/${a.id}`);
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
          <p className="muted-text"><Clock size={14} aria-hidden="true" /> {t.durationMinutes} minutes{t.depositMinor > 0 ? `. Deposit ${formatNaira(t.depositMinor)}.` : ''}</p>
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
            {!slots.loading && (slots.data?.length ?? 0) === 0 && <><Note>No times are open online for this date. Try another day, or call us and we will fit you in.</Note><CallLink /></>}
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
                <button className="btn primary full" disabled={busy || (atHome && !addressId)} onClick={() => details.ask(() => void book())}>{busy ? 'Booking…' : 'Book and pay'}</button>
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
  const info = SERVICE_TITLE[division] ?? { title: 'Services', sub: '' };
  const list = useLoad(() => get(`/services?division=${division}`).then(rows), [division]);
  const [picked, setPicked] = useState<any>(null);
  const cats = useMemo(() => [...new Set((list.data ?? []).map((s: any) => s.category).filter(Boolean))] as string[], [list.data]);
  const wanted = params.get('category') ?? '';
  const category = cats.find((c) => c.toLowerCase() === wanted.toLowerCase()) ?? '';
  const choose = (c: string) => setParams(c ? { category: c } : {}, { replace: true });
  const shown = (list.data ?? []).filter((s: any) => !category || s.category === category);
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
                {s.durationMinutes && <span>{s.durationMinutes} min</span>}
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

function ServiceSheet({ service, onClose }: { service: any; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [atHome, setAtHome] = useState(service.serviceMode === 'AT_HOME');
  const [addressId, setAddressId] = useState('');
  const [busy, setBusy] = useState(false);
  const details = useDetailsFirst();
  const home = service.serviceMode === 'AT_HOME' || (service.serviceMode === 'EITHER' && atHome);
  const send = async () => {
    setBusy(true);
    try {
      await post('/services/bookings', {
        offeringId: service.id,
        ...(when ? { scheduledStart: new Date(when).toISOString() } : {}),
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
      <Field label="Preferred date and time (optional)"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <Field label="Tell us what you need (optional)"><textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <button className="btn primary full" disabled={busy || (home && !addressId)} onClick={() => details.ask(() => void send())}>{busy ? 'Sending…' : 'Send request'}</button>
      {details.sheet}
      <small className="muted-text">Our team confirms the time and any price before you pay.</small>
    </Sheet>
  );
}

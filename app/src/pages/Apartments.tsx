import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BedDouble, Bath, Clock, MapPin, Users } from 'lucide-react';
import { formatNaira, get, getSession, idempotency, post, rows } from '../api';
import { CallLink, Empty, Field, lagosDate, Loader, Note, PageTitle, Photo, Sheet, useLoad, useToast } from '../ui';

export function ApartmentsPage() {
  const [location, setLocation] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const query = checkIn && checkOut && checkOut > checkIn ? `&checkIn=${checkIn}&checkOut=${checkOut}` : '';
  const stays = useLoad(() => get(`/apartments/properties?pageSize=100${query}`).then(rows), [query]);
  const places = useMemo(() => [...new Set((stays.data ?? []).map((p: any) => p.location ?? p.city).filter(Boolean))] as string[], [stays.data]);
  const shown = (stays.data ?? []).filter((p: any) => !location || (p.location ?? p.city) === location);
  return (
    <>
      <PageTitle title="Apartments" sub="Stay a night, a week or longer. Book the whole home or a single room." />
      <div className="date-pair">
        <Field label="Check in"><input type="date" min={lagosDate()} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></Field>
        <Field label="Check out"><input type="date" min={checkIn || lagosDate(1)} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
      </div>
      {places.length > 1 && (
        <div className="chips" role="group" aria-label="Location">
          <button className={!location ? 'on' : ''} onClick={() => setLocation('')}>All</button>
          {places.map((l) => <button key={l} className={location === l ? 'on' : ''} onClick={() => setLocation(l)}>{l}</button>)}
        </div>
      )}
      {stays.loading && !stays.data && <Loader />}
      {stays.error && <Note tone="error">{stays.error}</Note>}
      {stays.data && shown.length === 0 && <Empty title="No apartments to show">{query ? 'Try other dates.' : 'Our team is getting these ready. Please check back soon.'}</Empty>}
      <div className="grid wide">
        {shown.map((p: any) => (
          <Link key={p.id} to={`/apartments/${p.slug}`} className="card stay">
            <div className="card-photo"><Photo src={p.image} alt={p.name} /></div>
            <div className="card-body">
              <strong>{p.name}</strong>
              <small><MapPin size={13} aria-hidden="true" /> {[p.location, p.city].filter((x: any, i: number, a: any[]) => x && a.indexOf(x) === i).join(', ')}</small>
              <small>{p.availableUnitCount ?? p.unitCount} {(p.availableUnitCount ?? p.unitCount) === 1 ? 'apartment' : 'apartments'}{p.availableRoomCount ? `, ${p.availableRoomCount} single rooms` : ''}</small>
              {p.nightlyFromMinor === null || p.nightlyFromMinor === undefined
                ? <span className="price muted">Contact for price</span>
                : <span className="price">From {formatNaira(p.roomFromMinor ?? p.nightlyFromMinor)} <small>a night</small></span>}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function ApartmentPage() {
  const { slug = '' } = useParams();
  const property = useLoad(() => get(`/apartments/properties/${slug}`), [slug]);
  const [picked, setPicked] = useState<{ unit: any; room?: any } | null>(null);
  const [photo, setPhoto] = useState(0);
  const p = property.data;
  if (property.loading && !p) return <Loader />;
  if (!p) return <><PageTitle title="Not available" /><Empty title="This apartment is not available right now" /></>;
  const photos = [...(p.images ?? []), ...p.units.flatMap((u: any) => u.images ?? [])];
  const main = photos[photo] ?? photos[0];
  return (
    <article className="detail">
      <PageTitle title={p.name} sub={p.addressLine || [p.location, p.city].filter((x: any, i: number, l: any[]) => x && l.indexOf(x) === i).join(', ')} />
      <div className="stay-photo"><Photo src={main?.url} alt={main?.altText ?? p.name} /></div>
      {photos.length > 1 && <div className="thumbs wide">{photos.slice(0, 24).map((i: any, n: number) => <button key={i.id ?? n} className={n === photo ? 'on' : ''} aria-label={`Photo ${n + 1}`} onClick={() => setPhoto(n)}><img src={i.url} alt="" loading="lazy" /></button>)}</div>}
      {p.description && <p className="lede-text">{p.description}</p>}
      <p className="muted-text"><Clock size={14} aria-hidden="true" /> Check in from {p.checkInTime}. Check out by {p.checkOutTime}.</p>
      {p.amenities?.length > 0 && <ul className="pills">{p.amenities.map((a: string) => <li key={a}>{a}</li>)}</ul>}

      {p.units.length === 0 && <Empty title="Nothing is open to book here yet">Please call us and we will tell you when it is ready.</Empty>}
      {p.units.map((u: any) => (
        <section key={u.id} className="panel">
          <h2>{u.name}</h2>
          <p className="facts-row">
            <span><BedDouble size={15} aria-hidden="true" /> {u.bedrooms} bed</span>
            <span><Bath size={15} aria-hidden="true" /> {u.bathrooms} bath</span>
            <span><Users size={15} aria-hidden="true" /> Up to {u.maxGuests}</span>
          </p>
          {u.description && <p>{u.description}</p>}
          <div className="book-line">
            <div><b>Whole apartment</b><small>{u.nightlyRateMinor === null ? 'Contact for price' : `${formatNaira(u.nightlyRateMinor)} a night`}</small></div>
            {u.nightlyRateMinor === null ? <CallLink /> : <button className="btn primary" onClick={() => setPicked({ unit: u })}>Choose dates</button>}
          </div>
          {u.rooms?.map((r: any) => (
            <div key={r.id} className="book-line">
              <div><b>{r.name}</b><small>{r.nightlyRateMinor === null ? 'Contact for price' : `${formatNaira(r.nightlyRateMinor)} a night`}. Up to {r.maxGuests}.</small></div>
              {r.nightlyRateMinor === null ? <CallLink /> : <button className="btn ghost" onClick={() => setPicked({ unit: u, room: r })}>Choose dates</button>}
            </div>
          ))}
        </section>
      ))}
      {picked && <ReserveSheet unit={picked.unit} room={picked.room} onClose={() => setPicked(null)} />}
    </article>
  );
}

function ReserveSheet({ unit, room, onClose }: { unit: any; room?: any; onClose: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const [checkIn, setCheckIn] = useState(lagosDate(1));
  const [checkOut, setCheckOut] = useState(lagosDate(2));
  const [guests, setGuests] = useState(1);
  const [quote, setQuote] = useState<any>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const maxGuests = room?.maxGuests ?? unit.maxGuests;

  useEffect(() => {
    setQuote(null);
    setProblem(null);
    if (!checkIn || !checkOut || checkOut <= checkIn) return;
    let live = true;
    const q = new URLSearchParams({ checkIn, checkOut, guests: String(guests), ...(room ? { roomId: room.id } : {}) });
    get(`/apartments/units/${unit.id}/quote?${q}`)
      .then((r) => live && setQuote(r))
      .catch((e) => live && setProblem(e.message));
    return () => {
      live = false;
    };
  }, [checkIn, checkOut, guests, unit.id, room]);

  const reserve = async () => {
    if (!getSession()) {
      navigate(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setBusy(true);
    try {
      const r = await post('/apartments/reservations', { unitId: unit.id, ...(room ? { roomId: room.id } : {}), checkIn, checkOut, guests }, idempotency());
      navigate(`/pay/APARTMENT_RESERVATION/${r.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={room ? room.name : unit.name} onClose={onClose}>
      <div className="date-pair">
        <Field label="Check in"><input type="date" min={lagosDate()} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></Field>
        <Field label="Check out"><input type="date" min={checkIn} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
      </div>
      <Field label="Guests">
        <select value={guests} onChange={(e) => setGuests(Number(e.target.value))}>
          {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      {problem && <Note tone="warn">{problem}</Note>}
      {quote && (
        <>
          <div className="sum"><span>{quote.nights} {quote.nights === 1 ? 'night' : 'nights'} at {formatNaira(quote.nightlyRateMinor)}</span><span>{formatNaira(quote.accommodationMinor)}</span></div>
          {quote.cleaningFeeMinor > 0 && <div className="sum"><span>Cleaning</span><span>{formatNaira(quote.cleaningFeeMinor)}</span></div>}
          {quote.cautionDepositMinor > 0 && <div className="sum"><span>Refundable caution deposit</span><span>{formatNaira(quote.cautionDepositMinor)}</span></div>}
          <div className="sum total"><span>Total</span><b>{formatNaira(quote.totalMinor)}</b></div>
          {!quote.available && <Note tone="warn">Those dates are taken. Please try others.</Note>}
        </>
      )}
      <button className="btn primary full" disabled={busy || !quote?.available} onClick={reserve}>{busy ? 'Holding your dates…' : 'Reserve and pay'}</button>
      <small className="muted-text">Your dates are held for a short time while you pay.</small>
    </Sheet>
  );
}

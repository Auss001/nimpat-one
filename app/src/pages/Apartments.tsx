import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BedDouble, Bath, Clock, MapPin, Users } from 'lucide-react';
import { formatNaira, get, idempotency, post, rows } from '../api';
import { useDetailsFirst } from './Account';
import { CallLink, Empty, FavButton, Field, lagosDate, Loader, Note, PageTitle, Photo, PhotoGallery, Sheet, useLoad, useToast } from '../ui';

export interface Stay {
  key: string;
  to: string;
  name: string;
  code: string;
  place: string;
  image?: string;
  unit: any;
  property: any;
}

const placeOf = (p: any) => [p.location, p.city].filter((x: any, i: number, a: any[]) => x && a.indexOf(x) === i).join(', ');

/** Every flat is its own listing, even when several share one building. */
export async function loadStays(): Promise<Stay[]> {
  const properties = rows(await get('/apartments/properties?pageSize=100'));
  const details = await Promise.all(properties.map((p: any) => get(`/apartments/properties/${p.slug}`).catch(() => null)));
  return details.filter(Boolean).flatMap((p: any) =>
    p.units.map((u: any) => ({
      key: `${p.slug}--${u.id}`,
      to: `/apartments/${p.slug}?unit=${u.id}`,
      name: u.name,
      code: u.code,
      place: placeOf(p),
      image: u.images?.[0]?.url ?? p.images?.[0]?.url,
      unit: u,
      property: p,
    })),
  );
}

export function StayCard({ stay, wide }: { stay: Stay; wide?: boolean }) {
  const u = stay.unit;
  const roomFrom = u.rooms?.length ? Math.min(...u.rooms.map((r: any) => Number(r.nightlyRateMinor))) : null;
  return (
    <Link to={stay.to} className={`card ${wide ? 'wide' : 'stay'}`}>
      <FavButton kind="PROPERTY" slug={stay.key} />
      <div className="card-photo"><Photo src={stay.image} alt={stay.name} /></div>
      <div className="card-body">
        <strong>{stay.name}</strong>
        <small><MapPin size={13} aria-hidden="true" /> {stay.code}, {stay.place}</small>
        <span className="price">{formatNaira(u.nightlyRateMinor)} <small>a night</small></span>
        {roomFrom !== null && <small>Or a room from {formatNaira(roomFrom)}</small>}
      </div>
    </Link>
  );
}

export function ApartmentsPage() {
  const [location, setLocation] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const stays = useLoad(loadStays);
  const hasDates = !!checkIn && !!checkOut && checkOut > checkIn;
  const free = useLoad(async () => {
    if (!hasDates || !stays.data) return null;
    const checks = await Promise.all(
      stays.data.map(async (s) => {
        const whole = await get(`/apartments/units/${s.unit.id}/quote?checkIn=${checkIn}&checkOut=${checkOut}`).catch(() => null);
        if (whole?.available) return s.key;
        const rooms = await Promise.all((s.unit.rooms ?? []).map((r: any) => get(`/apartments/units/${s.unit.id}/quote?checkIn=${checkIn}&checkOut=${checkOut}&roomId=${r.id}`).catch(() => null)));
        return rooms.some((q) => q?.available) ? s.key : null;
      }),
    );
    return new Set(checks.filter(Boolean));
  }, [hasDates, checkIn, checkOut, stays.data]);
  const places = useMemo(() => [...new Set((stays.data ?? []).map((s) => s.property.location ?? s.property.city).filter(Boolean))] as string[], [stays.data]);
  const shown = (stays.data ?? []).filter((s) => (!location || (s.property.location ?? s.property.city) === location) && (!free.data || free.data.has(s.key)));
  return (
    <>
      <PageTitle title="Luxury Apartments" />
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
      {stays.data && shown.length === 0 && <Empty title="Nothing to show">{hasDates ? 'Try other dates.' : 'Please check back soon.'}</Empty>}
      <div className="grid wide">{shown.map((s) => <StayCard key={s.key} stay={s} />)}</div>
    </>
  );
}

export function ApartmentPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const unitId = params.get('unit');
  const property = useLoad(() => get(`/apartments/properties/${slug}`), [slug]);
  const [booking, setBooking] = useState<any>(null);
  const p = property.data;
  if (property.loading && !p) return <Loader />;
  if (!p) return <><PageTitle title="Not available" /><Empty title="This apartment is not available right now" /></>;
  const units = unitId ? p.units.filter((u: any) => u.id === unitId) : p.units;
  const single = units.length === 1 ? units[0] : null;
  const photos = single?.images?.length ? single.images : [...(p.images ?? []), ...units.flatMap((u: any) => u.images ?? [])];
  return (
    <article className="detail">
      <PageTitle
        title={single?.name ?? p.name}
        sub={single ? `${single.code}, ${placeOf(p)}` : p.addressLine || placeOf(p)}
        action={<FavButton kind="PROPERTY" slug={single ? `${p.slug}--${single.id}` : p.slug} inline />}
      />
      <PhotoGallery photos={photos.slice(0, 24)} alt={single?.name ?? p.name} />
      <p className="muted-text"><Clock size={14} aria-hidden="true" /> Check in from {p.checkInTime}. Check out by {p.checkOutTime}.</p>
      {p.amenities?.length > 0 && <ul className="pills">{p.amenities.map((a: string) => <li key={a}>{a}</li>)}</ul>}

      {units.length === 0 && <Empty title="Nothing is open to book here yet" action={<CallLink />} />}
      {units.map((u: any) => (
        <section key={u.id} className="panel">
          {!single && <h2>{u.name}</h2>}
          <p className="facts-row">
            <span><BedDouble size={15} aria-hidden="true" /> {u.bedrooms} bed</span>
            <span><Bath size={15} aria-hidden="true" /> {u.bathrooms} bath</span>
            <span><Users size={15} aria-hidden="true" /> Up to {u.maxGuests}</span>
          </p>
          {u.description && <p>{u.description}</p>}
          <div className="book-line">
            <div>
              <b>{formatNaira(u.nightlyRateMinor)} a night</b>
              {u.rooms?.length > 0 && <small>Whole flat. Rooms from {formatNaira(Math.min(...u.rooms.map((r: any) => Number(r.nightlyRateMinor))))}.</small>}
            </div>
            <button className="btn primary" onClick={() => setBooking(u)}>Book</button>
          </div>
        </section>
      ))}
      {booking && <ReserveSheet unit={booking} onClose={() => setBooking(null)} />}
    </article>
  );
}

interface Quote {
  rooms: any[];
  nights: number;
  accommodationMinor: number;
  cleaningFeeMinor: number;
  cautionDepositMinor: number;
  totalMinor: number;
}

/** Whole flat, one room or several. Rooms are chosen for the customer from those free on the dates. */
function ReserveSheet({ unit, onClose }: { unit: any; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const rooms: any[] = unit.rooms ?? [];
  const [count, setCount] = useState(0); // 0 means the whole flat.
  const [checkIn, setCheckIn] = useState(lagosDate(1));
  const [checkOut, setCheckOut] = useState(lagosDate(2));
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuote(null);
    setProblem(null);
    if (!checkIn || !checkOut || checkOut <= checkIn) return;
    let live = true;
    const url = (roomId?: string) => `/apartments/units/${unit.id}/quote?${new URLSearchParams({ checkIn, checkOut, ...(roomId ? { roomId } : {}) })}`;
    (async () => {
      if (count === 0) {
        const q = await get(url());
        if (!q.available) throw new Error('The whole flat is taken on those dates. A room may still be free.');
        return { rooms: [], ...q };
      }
      const quotes = await Promise.all(rooms.map((r) => get(url(r.id)).then((q) => ({ room: r, q })).catch(() => null)));
      const free = quotes.filter((x) => x?.q.available).slice(0, count) as { room: any; q: any }[];
      if (free.length < count) throw new Error(free.length ? `Only ${free.length} ${free.length === 1 ? 'room is' : 'rooms are'} free on those dates.` : 'No rooms are free on those dates.');
      const add = (field: string) => free.reduce((n, x) => n + Number(x.q[field]), 0);
      return { rooms: free.map((x) => x.room), nights: free[0].q.nights, accommodationMinor: add('accommodationMinor'), cleaningFeeMinor: add('cleaningFeeMinor'), cautionDepositMinor: add('cautionDepositMinor'), totalMinor: add('totalMinor') };
    })()
      .then((q) => {
        if (live) setQuote(q);
      })
      .catch((e) => {
        if (live) setProblem(e.message);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkIn, checkOut, unit.id, count]);

  const details = useDetailsFirst();
  const reserve = async () => {
    if (!quote) return;
    setBusy(true);
    try {
      // Several rooms are held together as one booking with one payment for all of them.
      const body = count === 0 ? { unitId: unit.id, checkIn, checkOut } : { unitId: unit.id, roomIds: quote.rooms.map((r) => r.id), checkIn, checkOut };
      const held = await post('/apartments/reservations', body, idempotency());
      navigate(`/pay/APARTMENT_RESERVATION/${held.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const choices = [
    { n: 0, label: 'Whole flat', price: Number(unit.nightlyRateMinor) },
    ...rooms.slice(0, Math.max(rooms.length - 1, 0)).map((_, i) => ({
      n: i + 1,
      label: i === 0 ? '1 room' : `${i + 1} rooms`,
      price: rooms.slice(0, i + 1).reduce((sum, r) => sum + Number(r.nightlyRateMinor), 0),
    })),
  ];

  return (
    <Sheet title={unit.name} onClose={onClose}>
      {choices.length > 1 && (
        <div className="room-choices" role="group" aria-label="What would you like to book?">
          {choices.map((c) => (
            <button key={c.n} className={count === c.n ? 'on' : ''} onClick={() => setCount(c.n)}>
              <b>{c.label}</b>
              <small>{formatNaira(c.price)}</small>
            </button>
          ))}
        </div>
      )}
      <div className="date-pair">
        <Field label="Check in"><input type="date" min={lagosDate()} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></Field>
        <Field label="Check out"><input type="date" min={checkIn} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
      </div>
      {problem && <Note tone="warn">{problem}</Note>}
      {quote && (
        <>
          <div className="sum"><span>{quote.rooms.length > 1 ? `${quote.rooms.length} rooms × ` : ''}{quote.nights} {quote.nights === 1 ? 'night' : 'nights'}</span><span>{formatNaira(quote.accommodationMinor)}</span></div>
          {quote.cleaningFeeMinor > 0 && <div className="sum"><span>Cleaning</span><span>{formatNaira(quote.cleaningFeeMinor)}</span></div>}
          {quote.cautionDepositMinor > 0 && <div className="sum"><span>Refundable caution deposit</span><span>{formatNaira(quote.cautionDepositMinor)}</span></div>}
          <div className="sum total"><span>Total</span><b>{formatNaira(quote.totalMinor)}</b></div>
        </>
      )}
      <button className="btn primary full" disabled={busy || !quote} onClick={() => details.ask(() => void reserve())}>{busy ? 'Holding your dates…' : 'Reserve and pay'}</button>
      {details.sheet}
    </Sheet>
  );
}

import { Fragment, useState } from 'react';
import { get, patch, post } from '../api';
import { PhotoManager, type PhotoTarget } from '../components/PhotoManager';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira, slugify } from '../money';

type Listing = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
type Readiness = 'READY' | 'FINISHING' | 'NOT_READY' | 'SERVICING' | 'MAINTENANCE';
const READINESS: Record<Readiness, { label: string; tone: 'green' | 'amber' | 'red' | 'blue' }> = {
  READY: { label: 'Ready to sell', tone: 'green' },
  FINISHING: { label: 'Finishing touches', tone: 'amber' },
  NOT_READY: { label: 'Not ready', tone: 'red' },
  SERVICING: { label: 'Being serviced', tone: 'blue' },
  MAINTENANCE: { label: 'Under maintenance', tone: 'red' },
};
const READINESS_KEYS = Object.keys(READINESS) as Readiness[];
interface Room {
  id: string;
  slot: number;
  name: string;
  description: string | null;
  maxGuests: number;
  nightlyRateMinor: number;
  cleaningFeeMinor: number;
  cautionDepositMinor: number;
  status: Listing;
  readiness: Readiness;
  readinessNote: string | null;
}
interface Unit {
  id: string;
  code: string;
  name: string;
  description: string | null;
  bedrooms: number;
  bathrooms: number;
  maxGuests: number;
  nightlyRateMinor: number;
  cautionDepositMinor: number;
  cleaningFeeMinor: number;
  minNights: number;
  maxNights: number;
  status: Listing;
  readiness: Readiness;
  readinessNote: string | null;
  rooms: Room[];
}
interface Property {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  addressLine: string;
  location: string | null;
  city: string;
  state: string;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  status: Listing;
  units: Unit[];
  images: { id: string; url: string; unitId: string | null }[];
}

const LOCATIONS = ['Mabushi', 'Wuye', 'Lagos', 'Port Harcourt'];
const OTHER = 'Other';

export function ApartmentsPage() {
  const [show, setShow] = useState<'live' | 'all'>('live');
  const [location, setLocation] = useState('all');
  const props = useLoad(() => get<Property[]>('/admin/apartments/properties'));
  const [editProp, setEditProp] = useState<Property | 'new' | null>(null);
  const [editUnit, setEditUnit] = useState<{ property: Property; unit?: Unit } | null>(null);
  const [blockUnit, setBlockUnit] = useState<Unit | null>(null);
  const [editRoom, setEditRoom] = useState<{ unit: Unit; room?: Room } | null>(null);
  const [photos, setPhotos] = useState<PhotoTarget | null>(null);
  const { run } = useAction();

  const visible = (props.data ?? []).filter((p) => show === 'all' || p.status === 'ACTIVE' || p.status === 'DRAFT');
  const inGroup = (p: Property, group: string) => (p.location ?? OTHER) === group;
  const extras = visible.map((p) => p.location ?? OTHER).filter((l) => !LOCATIONS.includes(l) && l !== OTHER).sort();
  const groups = [...new Set([...LOCATIONS, ...extras, OTHER])].filter((g) => visible.some((p) => inGroup(p, g)));

  const saveRate = (u: Unit, kobo: number) =>
    run(async () => {
      await patch(`/admin/apartments/units/${u.id}`, { nightlyRateMinor: kobo });
      await props.reload();
    }, `${u.name}: nightly rate ${formatNaira(kobo)}`);

  const saveRoomRate = (r: Room, kobo: number) =>
    run(async () => {
      await patch(`/admin/apartments/rooms/${r.id}`, { nightlyRateMinor: kobo });
      await props.reload();
    }, `${r.name}: nightly rate ${formatNaira(kobo)}`);

  const toggleUnit = (u: Unit) =>
    run(async () => {
      await patch(`/admin/apartments/units/${u.id}`, { status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      await props.reload();
    }, u.status === 'ACTIVE' ? `${u.name} taken off the booking site` : `${u.name} is bookable again`);

  return (
    <>
      <PageHead
        title="Luxury Apartments"
        subtitle="Click a nightly rate to change it. Switching a unit off hides it from new bookings; existing reservations are kept."
        actions={
          <>
            <Tabs value={show} onChange={setShow} options={[{ value: 'live', label: 'Live' }, { value: 'all', label: 'Include switched off' }]} />
            <button className="btn primary" onClick={() => setEditProp('new')}>+ Add property</button>
          </>
        }
      />
      <div className="toolbar" style={{ gap: 8, flexWrap: 'wrap' }} aria-label="Apartment readiness summary">
        {READINESS_KEYS.map((k) => {
          const count = visible.flatMap((p) => (p.status === 'ACTIVE' ? p.units : [])).filter((u) => u.readiness === k && u.status !== 'INACTIVE').length;
          return count ? <Pill key={k} tone={READINESS[k].tone}>{READINESS[k].label}: {count}</Pill> : null;
        })}
      </div>
      <div className="toolbar">
        <Tabs value={location} onChange={setLocation} options={[{ value: 'all', label: 'All locations' }, ...groups.map((g) => ({ value: g, label: `${g} (${visible.filter((p) => inGroup(p, g)).length})` }))]} />
      </div>
      <Loading error={props.error} loading={props.loading && !props.data} />
      {groups.filter((g) => location === 'all' || g === location).map((group) => (
      <section key={group} style={{ marginBottom: 24 }}>
      <h2 style={{ marginBottom: 12 }}>{group}</h2>
      <div className="grid">
        {visible.filter((p) => inGroup(p, group)).map((p) => {
          const cover = p.images.find((i) => !i.unitId) ?? p.images[0];
          return (
            <div className="card" key={p.id}>
              <div className="card-pad" style={{ display: 'flex', gap: 14, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                {cover ? <img src={cover.url} alt="" style={{ width: 72, height: 54, objectFit: 'cover', borderRadius: 6 }} /> : null}
                <div style={{ flex: 1 }}>
                  <h2>{p.name} <StatusPill status={p.status} /></h2>
                  <div className="muted small">{p.addressLine} · {p.city}, {p.state} · check-in {p.checkInTime}, check-out {p.checkOutTime}</div>
                </div>
                <button className="btn sm" onClick={() => setEditProp(p)}>Edit property</button>
                <button className="btn sm" onClick={() => setPhotos({ owner: 'property', id: p.id })}>Property photos</button>
                <button className="btn sm" onClick={() => setEditUnit({ property: p })}>+ Add unit</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Unit</th><th className="num">Beds</th><th className="num">Baths</th><th className="num">Guests</th>
                      <th className="num">Per night</th><th className="num">Cleaning</th><th className="num">Caution deposit</th><th>Condition</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.units.length === 0 && <tr><td colSpan={10} className="muted">No units yet.</td></tr>}
                    {p.units.map((u) => (
                      <Fragment key={u.id}>
                      <tr>
                        <td><strong>{u.name}</strong><div className="muted small">{u.code}</div></td>
                        <td className="num">{u.bedrooms}</td>
                        <td className="num">{u.bathrooms}</td>
                        <td className="num">{u.maxGuests}</td>
                        <td className="num"><InlinePrice minor={u.nightlyRateMinor} onSave={(k) => saveRate(u, k)} /></td>
                        <td className="num">{formatNaira(u.cleaningFeeMinor)}</td>
                        <td className="num">{formatNaira(u.cautionDepositMinor)}</td>
                        <td><Pill tone={READINESS[u.readiness].tone}>{READINESS[u.readiness].label}</Pill>{u.readinessNote && <div className="muted small">{u.readinessNote}</div>}</td>
                        <td><StatusPill status={u.status} /></td>
                        <td>
                          <div className="row-actions">
                            <button className="btn sm" onClick={() => setEditUnit({ property: p, unit: u })}>Edit</button>
                            <button className="btn sm" onClick={() => setPhotos({ owner: 'unit', id: u.id })}>Photos</button>
                            <button className="btn sm" onClick={() => setEditRoom({ unit: u })}>+ Add room</button>
                            <button className="btn sm" onClick={() => setBlockUnit(u)}>Block dates</button>
                            <button className={`btn sm ${u.status === 'ACTIVE' ? 'danger' : ''}`} onClick={() => void toggleUnit(u)}>
                              {u.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {u.rooms.map((r) => (
                        <tr key={r.id} style={{ background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
                          <td style={{ paddingLeft: 28 }}>{r.name}<div className="muted small">Bookable on its own</div></td>
                          <td className="num">1</td>
                          <td className="num"></td>
                          <td className="num">{r.maxGuests}</td>
                          <td className="num"><InlinePrice minor={r.nightlyRateMinor} onSave={(k) => saveRoomRate(r, k)} /></td>
                          <td className="num">{formatNaira(r.cleaningFeeMinor)}</td>
                          <td className="num">{formatNaira(r.cautionDepositMinor)}</td>
                          <td><Pill tone={READINESS[r.readiness].tone}>{READINESS[r.readiness].label}</Pill>{r.readinessNote && <div className="muted small">{r.readinessNote}</div>}</td>
                          <td><StatusPill status={r.status} /></td>
                          <td><div className="row-actions"><button className="btn sm" onClick={() => setEditRoom({ unit: u, room: r })}>Edit</button></div></td>
                        </tr>
                      ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
      </section>
      ))}
      {editProp && <PropertyForm property={editProp === 'new' ? undefined : editProp} onClose={() => setEditProp(null)} onSaved={() => { setEditProp(null); void props.reload(); }} />}
      {editUnit && <UnitForm {...editUnit} onClose={() => setEditUnit(null)} onSaved={() => { setEditUnit(null); void props.reload(); }} />}
      {blockUnit && <BlockForm unit={blockUnit} onClose={() => setBlockUnit(null)} />}
      {photos && <PhotoManager {...photos} onClose={() => setPhotos(null)} onChanged={() => void props.reload()} />}
      {editRoom && <RoomForm {...editRoom} onClose={() => setEditRoom(null)} onSaved={() => { setEditRoom(null); void props.reload(); }} />}
    </>
  );
}

function PropertyForm({ property, onClose, onSaved }: { property?: Property; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    name: property?.name ?? '',
    description: property?.description ?? '',
    addressLine: property?.addressLine ?? '',
    location: property?.location ?? '',
    city: property?.city ?? 'Abuja',
    state: property?.state ?? 'FCT',
    amenities: property?.amenities.join(', ') ?? '',
    checkInTime: property?.checkInTime ?? '14:00',
    checkOutTime: property?.checkOutTime ?? '12:00',
    status: property?.status ?? ('ACTIVE' as Listing),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = f.name.trim().length >= 2 && f.addressLine.trim().length >= 3 && /^\d\d:\d\d$/.test(f.checkInTime) && /^\d\d:\d\d$/.test(f.checkOutTime);

  const save = () =>
    run(async () => {
      const body = { ...f, amenities: f.amenities.split(',').map((a) => a.trim()).filter(Boolean), description: f.description || undefined, location: f.location.trim() || undefined };
      if (property) await patch(`/admin/apartments/properties/${property.id}`, body);
      else await post('/admin/apartments/properties', { ...body, slug: `${slugify(f.name)}-${Date.now().toString(36)}` });
    }, 'Property saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={property ? `Edit ${property.name}` : 'Add property'}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Property name" full><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Address / area" full><input value={f.addressLine} onChange={set('addressLine')} /></Field>
        <Field label="Location group" hint="Pick one, or type a new location" full>
          <input list="property-locations" value={f.location} onChange={set('location')} placeholder="Mabushi" />
          <datalist id="property-locations">{LOCATIONS.map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
        <Field label="City"><input value={f.city} onChange={set('city')} /></Field>
        <Field label="State"><input value={f.state} onChange={set('state')} /></Field>
        <Field label="Check-in time"><input value={f.checkInTime} onChange={set('checkInTime')} placeholder="14:00" /></Field>
        <Field label="Check-out time"><input value={f.checkOutTime} onChange={set('checkOutTime')} placeholder="12:00" /></Field>
        <Field label="Amenities" hint="Comma-separated" full><textarea value={f.amenities} onChange={set('amenities')} /></Field>
        <Field label="Description" full><textarea value={f.description} onChange={set('description')} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            <option value="ACTIVE">Live</option><option value="DRAFT">Draft (hidden)</option><option value="INACTIVE">Switched off</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function UnitForm({ property, unit, onClose, onSaved }: { property: Property; unit?: Unit; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    code: unit?.code ?? '',
    name: unit?.name ?? '',
    description: unit?.description ?? '',
    bedrooms: String(unit?.bedrooms ?? 1),
    bathrooms: String(unit?.bathrooms ?? 1),
    maxGuests: String(unit?.maxGuests ?? 2),
    minNights: String(unit?.minNights ?? 1),
    maxNights: String(unit?.maxNights ?? 90),
    status: unit?.status ?? ('ACTIVE' as Listing),
    readiness: unit?.readiness ?? ('READY' as Readiness),
    readinessNote: unit?.readinessNote ?? '',
  });
  const [rate, setRate] = useState<number | null>(unit?.nightlyRateMinor ?? null);
  const [cleaning, setCleaning] = useState<number | null>(unit?.cleaningFeeMinor ?? 0);
  const [caution, setCaution] = useState<number | null>(unit?.cautionDepositMinor ?? 0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (s: string) => Number(s);
  const valid = f.code.trim() && f.name.trim().length >= 2 && rate !== null && rate > 0 && cleaning !== null && caution !== null &&
    [f.bedrooms, f.maxGuests, f.minNights, f.maxNights].every((x) => Number.isInteger(num(x))) && !Number.isNaN(num(f.bathrooms));

  const save = () =>
    run(async () => {
      const body = {
        code: f.code.trim(), name: f.name.trim(), description: f.description || undefined,
        bedrooms: num(f.bedrooms), bathrooms: num(f.bathrooms), maxGuests: num(f.maxGuests), minNights: num(f.minNights), maxNights: num(f.maxNights),
        nightlyRateMinor: rate, cleaningFeeMinor: cleaning, cautionDepositMinor: caution, status: f.status,
        readiness: f.readiness, readinessNote: f.readinessNote.trim() || null,
      };
      if (unit) await patch(`/admin/apartments/units/${unit.id}`, body);
      else await post(`/admin/apartments/properties/${property.id}/units`, body);
    }, 'Unit saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={unit ? `Edit ${unit.name}` : `Add unit to ${property.name}`}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Unit name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Unit code" hint="e.g. Flat 5"><input value={f.code} onChange={set('code')} /></Field>
        <Field label="Bedrooms"><input inputMode="numeric" value={f.bedrooms} onChange={set('bedrooms')} /></Field>
        <Field label="Bathrooms" hint="3.5 = three plus a guest toilet"><input inputMode="decimal" value={f.bathrooms} onChange={set('bathrooms')} /></Field>
        <Field label="Maximum guests"><input inputMode="numeric" value={f.maxGuests} onChange={set('maxGuests')} /></Field>
        <Field label="Nightly rate (₦)"><MoneyInput value={rate} onChange={setRate} /></Field>
        <Field label="Cleaning fee (₦, once per stay)"><MoneyInput value={cleaning} onChange={setCleaning} /></Field>
        <Field label="Caution deposit (₦, refundable)"><MoneyInput value={caution} onChange={setCaution} /></Field>
        <Field label="Minimum nights"><input inputMode="numeric" value={f.minNights} onChange={set('minNights')} /></Field>
        <Field label="Maximum nights"><input inputMode="numeric" value={f.maxNights} onChange={set('maxNights')} /></Field>
        <Field label="Description" full><textarea value={f.description} onChange={set('description')} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            <option value="ACTIVE">Bookable</option><option value="DRAFT">Draft (hidden)</option><option value="INACTIVE">Switched off</option>
          </select>
        </Field>
        <Field label="Condition" hint="Only Ready to sell can be booked">
          <select value={f.readiness} onChange={set('readiness')}>{READINESS_KEYS.map((k) => <option key={k} value={k}>{READINESS[k].label}</option>)}</select>
        </Field>
        <Field label="Condition note" hint="Staff only, for example 90% ready" full><input value={f.readinessNote} onChange={set('readinessNote')} /></Field>
      </div>
    </Modal>
  );
}

function RoomForm({ unit, room, onClose, onSaved }: { unit: Unit; room?: Room; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    name: room?.name ?? '',
    description: room?.description ?? '',
    maxGuests: String(room?.maxGuests ?? 2),
    status: room?.status ?? ('ACTIVE' as Listing),
    readiness: room?.readiness ?? ('READY' as Readiness),
    readinessNote: room?.readinessNote ?? '',
  });
  const [rate, setRate] = useState<number | null>(room?.nightlyRateMinor ?? null);
  const [cleaning, setCleaning] = useState<number | null>(room?.cleaningFeeMinor ?? 0);
  const [caution, setCaution] = useState<number | null>(room?.cautionDepositMinor ?? 0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = f.name.trim().length >= 2 && rate !== null && rate > 0 && cleaning !== null && caution !== null && Number.isInteger(Number(f.maxGuests)) && Number(f.maxGuests) >= 1;
  const save = () =>
    run(async () => {
      const body = {
        name: f.name.trim(), description: f.description || undefined, maxGuests: Number(f.maxGuests), nightlyRateMinor: rate, cleaningFeeMinor: cleaning, cautionDepositMinor: caution,
        status: f.status, readiness: f.readiness, readinessNote: f.readinessNote.trim() || null,
      };
      if (room) await patch(`/admin/apartments/rooms/${room.id}`, body);
      else await post(`/admin/apartments/units/${unit.id}/rooms`, body);
    }, 'Room saved').then((ok) => ok && onSaved());
  return (
    <Modal
      title={room ? `Edit ${room.name}` : `Add a bookable room to ${unit.name}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Room name" full><input value={f.name} onChange={set('name')} placeholder="Bedroom 1" /></Field>
        <Field label="Nightly rate (₦)"><MoneyInput value={rate} onChange={setRate} /></Field>
        <Field label="Maximum guests"><input inputMode="numeric" value={f.maxGuests} onChange={set('maxGuests')} /></Field>
        <Field label="Cleaning fee (₦, once per stay)"><MoneyInput value={cleaning} onChange={setCleaning} /></Field>
        <Field label="Caution deposit (₦, refundable)"><MoneyInput value={caution} onChange={setCaution} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            <option value="ACTIVE">Bookable</option><option value="INACTIVE">Switched off</option>
          </select>
        </Field>
        <Field label="Condition" hint="Only Ready to sell can be booked">
          <select value={f.readiness} onChange={set('readiness')}>{READINESS_KEYS.map((k) => <option key={k} value={k}>{READINESS[k].label}</option>)}</select>
        </Field>
        <Field label="Condition note" hint="Staff only" full><input value={f.readinessNote} onChange={set('readinessNote')} /></Field>
        <Field label="Description" full><textarea value={f.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}

function BlockForm({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const { run, busy } = useAction();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('Maintenance');
  const valid = start && end && end > start;
  const save = () =>
    run(() => post(`/admin/apartments/units/${unit.id}/blackouts`, { startDate: start, endDate: end, reason }), 'Dates blocked').then((ok) => ok && onClose());
  return (
    <Modal
      title={`Block dates — ${unit.name}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Block</button></>}
    >
      <div className="form-grid">
        <Field label="From"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Until (not included)"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Reason" full><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

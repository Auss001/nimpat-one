import { useMemo, useState } from 'react';
import { get, patch, post } from '../api';
import { PhotoManager, type PhotoTarget } from '../components/PhotoManager';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira } from '../money';

type Mode = 'AT_VENUE' | 'AT_HOME' | 'EITHER';
interface Offering {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  serviceMode: Mode;
  homeFeeMinor: number | null;
  sortOrder: number;
  pricingType: 'FIXED' | 'STARTING_FROM' | 'QUOTE_REQUIRED';
  basePriceMinor: number | null;
  depositMinor: number | null;
  durationMinutes: number | null;
  isActive: boolean;
  verification: string;
  division: { code: string; name: string; slug: string };
}

/** Each department, with the kinds of service it usually lists (only suggestions: any category can be typed). */
const DIVISIONS: { slug: string; label: string; categories: string[] }[] = [
  { slug: 'pharmacy-laboratory', label: 'Pharmacy & laboratory', categories: ['Lab tests', 'Consultations', 'Home sample collection', 'Health checks'] },
  { slug: 'spa-wellness', label: 'Spa & wellness', categories: ['Home services', 'Packages', 'Bridal & events'] },
  { slug: 'automobiles', label: 'Automobiles', categories: ['Car hire', 'Hire purchase', 'Servicing & repairs', 'Inspection', 'Car care'] },
  { slug: 'transport-logistics', label: 'Transport & logistics', categories: ['Parcels & dispatch', 'Haulage', 'Moving', 'Airport transfers', 'Chartered buses'] },
  { slug: 'media-events-rentals', label: 'Media, events & rentals', categories: ['Equipment rental', 'Events', 'Media production'] },
  { slug: 'real-estate-interior-design', label: 'Real estate & interiors', categories: ['Interior design', 'Property', 'Consultations'] },
  { slug: 'entertainment', label: 'Entertainment', categories: ['Experiences', 'Passes'] },
];
const PRICING = { FIXED: 'Fixed price', STARTING_FROM: 'From', QUOTE_REQUIRED: 'On quotation' };
const MODE: Record<Mode, string> = { AT_VENUE: 'At our location', AT_HOME: "At the customer's address", EITHER: 'Customer chooses' };

export function ServicesPage() {
  const offerings = useLoad(() => get<Offering[]>('/admin/services').then((r) => r.filter((o) => !o.name.startsWith('[DEV SAMPLE]'))));
  const [division, setDivision] = useState('all');
  const [editing, setEditing] = useState<Offering | 'new' | null>(null);
  const [photos, setPhotos] = useState<PhotoTarget | null>(null);
  const { run } = useAction();

  const groups = useMemo(() => {
    const m = new Map<string, Offering[]>();
    for (const o of offerings.data ?? []) {
      if (division !== 'all' && o.division.slug !== division) continue;
      const key = `${o.division.name}${o.category ? ` · ${o.category}` : ''}`;
      m.set(key, [...(m.get(key) ?? []), o]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [offerings.data, division]);

  const update = (o: Offering, body: Record<string, unknown>, msg: string) =>
    run(async () => {
      await patch(`/admin/services/${o.id}`, body);
      await offerings.reload();
    }, msg);
  const publish = (o: Offering, live: boolean) =>
    run(async () => {
      await post('/admin/records/verification', { type: 'SERVICE_OFFERING', ids: [o.id], verification: live ? 'VERIFIED' : 'AWAITING_CONFIRMATION' });
      await offerings.reload();
    }, live ? `${o.name} is now in the app` : `${o.name} taken out of the app`);

  const present = new Set((offerings.data ?? []).map((o) => o.division.slug));
  return (
    <>
      <PageHead
        title="Services & bookings"
        subtitle="Lab tests, home visits, car hire, hire purchase, logistics, rentals and every other service customers can book. A new service shows in the app straight away; Hide takes it out."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>+ Add service</button>}
      />
      <Tabs value={division} onChange={setDivision} options={[{ value: 'all', label: 'All' }, ...DIVISIONS.filter((d) => present.has(d.slug)).map((d) => ({ value: d.slug, label: d.label }))]} />
      <Loading error={offerings.error} loading={offerings.loading && !offerings.data} />
      {offerings.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Service</th><th>Where</th><th>Pricing</th><th className="num">Price</th><th className="num">Home visit fee</th><th>In the app</th><th></th></tr></thead>
            <tbody>
              {groups.length === 0 && <tr><td colSpan={7} className="empty">Nothing yet. Use “Add service” to list the first one.</td></tr>}
              {groups.map(([group, list]) => [
                <tr className="group-row" key={`g-${group}`}><td colSpan={7}>{group} · {list.length}</td></tr>,
                ...list.map((o) => {
                  const live = o.isActive && o.verification === 'VERIFIED';
                  return (
                    <tr key={o.id}>
                      <td><strong>{o.name}</strong>{o.description && <div className="muted small" style={{ maxWidth: 480 }}>{o.description}</div>}</td>
                      <td className="small">{MODE[o.serviceMode]}</td>
                      <td className="small">{PRICING[o.pricingType]}</td>
                      <td className="num">
                        {o.pricingType === 'QUOTE_REQUIRED' ? <span className="muted">—</span> : (
                          <InlinePrice minor={o.basePriceMinor ?? 0} onSave={(k) => update(o, { basePriceMinor: k }, `${o.name}: ${formatNaira(k)}`)} />
                        )}
                      </td>
                      <td className="num">{o.serviceMode === 'AT_VENUE' ? <span className="muted">—</span> : o.homeFeeMinor ? formatNaira(o.homeFeeMinor) : 'Free'}</td>
                      <td>
                        {!o.isActive ? <StatusPill status="INACTIVE" /> : live ? <Pill tone="green">live</Pill> : <Pill tone="amber">not confirmed</Pill>}
                      </td>
                      <td><div className="row-actions">
                        {o.isActive && !live && <button className="btn sm primary" onClick={() => void publish(o, true)}>Confirm &amp; show</button>}
                        {live && <button className="btn sm" onClick={() => void publish(o, false)}>Hide</button>}
                        <button className="btn sm" onClick={() => setEditing(o)}>Edit</button>
                        <button className="btn sm" onClick={() => setPhotos({ owner: 'service', id: o.id })}>Photo</button>
                        <button className={`btn sm ${o.isActive ? 'danger' : ''}`} onClick={() => void update(o, { isActive: !o.isActive }, o.isActive ? `${o.name} removed` : `${o.name} restored`)}>
                          {o.isActive ? 'Remove' : 'Restore'}
                        </button>
                      </div></td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {photos && <PhotoManager {...photos} onClose={() => setPhotos(null)} />}
      {editing && <OfferingForm offering={editing === 'new' ? undefined : editing} initialDivision={division !== 'all' ? division : undefined} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void offerings.reload(); }} />}
    </>
  );
}

function OfferingForm({ offering, initialDivision, onClose, onSaved }: { offering?: Offering; initialDivision?: string; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [division, setDivision] = useState(offering?.division.slug ?? initialDivision ?? DIVISIONS[0].slug);
  const [name, setName] = useState(offering?.name ?? '');
  const [description, setDescription] = useState(offering?.description ?? '');
  const [category, setCategory] = useState(offering?.category ?? '');
  const [mode, setMode] = useState<Mode>(offering?.serviceMode ?? 'AT_VENUE');
  const [pricingType, setPricingType] = useState<Offering['pricingType']>(offering?.pricingType ?? 'FIXED');
  const [price, setPrice] = useState<number | null>(offering?.basePriceMinor ?? null);
  const [deposit, setDeposit] = useState<number | null>(offering?.depositMinor ?? null);
  const [homeFee, setHomeFee] = useState<number | null>(offering?.homeFeeMinor ?? null);
  const [duration, setDuration] = useState(offering?.durationMinutes ? String(offering.durationMinutes) : '');
  const [order, setOrder] = useState(String(offering?.sortOrder ?? 0));
  const valid = name.trim().length >= 2 && (pricingType === 'QUOTE_REQUIRED' || price !== null) && (!duration || Number(duration) >= 5);
  const suggestions = DIVISIONS.find((d) => d.slug === division)?.categories ?? [];

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        name: name.trim(), description: description.trim() || undefined, category: category.trim(), serviceMode: mode, pricingType,
        sortOrder: Number(order) || 0,
        ...(price !== null ? { basePriceMinor: price } : {}), ...(deposit !== null ? { depositMinor: deposit } : {}),
        ...(homeFee !== null ? { homeFeeMinor: homeFee } : {}), ...(duration ? { durationMinutes: Number(duration) } : {}),
      };
      if (offering) await patch(`/admin/services/${offering.id}`, body);
      else {
        const prefix = division.split('-').map((w) => w[0]).join('').toUpperCase();
        await post('/admin/services', { ...body, division, code: `${prefix}-${Date.now().toString(36).toUpperCase()}` });
      }
    }, 'Service saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={offering ? `Edit ${offering.name}` : 'Add service'}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        {!offering && (
          <Field label="Department" full>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              {DIVISIONS.map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Name" full><input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Malaria test, Car hire with driver, Interstate haulage" /></Field>
        <Field label="Description" full><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Group" hint="Services with the same group sit together in the app">
          <input list="service-groups" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={suggestions[0]} />
          <datalist id="service-groups">{suggestions.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Where it happens">
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {Object.entries(MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Pricing">
          <select value={pricingType} onChange={(e) => setPricingType(e.target.value as Offering['pricingType'])}>
            {Object.entries(PRICING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Price (₦)"><MoneyInput value={price} onChange={setPrice} placeholder="—" /></Field>
        {mode !== 'AT_VENUE' && <Field label="Home visit fee (₦)" hint="Added to a fixed price when we go to the customer. Empty = free."><MoneyInput value={homeFee} onChange={setHomeFee} placeholder="—" /></Field>}
        <Field label="Deposit / caution fee (₦)" hint="Optional"><MoneyInput value={deposit} onChange={setDeposit} placeholder="—" /></Field>
        <Field label="Duration (minutes)" hint="Optional"><input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))} placeholder="—" /></Field>
        <Field label="Order in the list" hint="Lower numbers come first"><input inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
    </Modal>
  );
}

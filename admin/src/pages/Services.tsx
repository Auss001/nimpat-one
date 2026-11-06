import { useMemo, useState } from 'react';
import { get, patch, post } from '../api';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, StatusPill, useAction, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface Offering {
  id: string;
  code: string;
  name: string;
  description: string | null;
  pricingType: 'FIXED' | 'STARTING_FROM' | 'QUOTE_REQUIRED';
  basePriceMinor: number | null;
  depositMinor: number | null;
  durationMinutes: number | null;
  isActive: boolean;
  division: { code: string; name: string; slug: string };
}

const DIVISIONS: [string, string][] = [
  ['media-events-rentals', 'Media, Events & Rentals'],
  ['real-estate-interior-design', 'Real Estate & Interior Design'],
  ['entertainment', 'Entertainment'],
  ['automobiles', 'Automobile services'],
  ['transport-logistics', 'Transport & Logistics'],
];
const PRICING = { FIXED: 'Fixed price', STARTING_FROM: 'From', QUOTE_REQUIRED: 'On quotation' };

export function ServicesPage() {
  const offerings = useLoad(() => get<Offering[]>('/admin/services').then((r) => r.filter((o) => !o.name.startsWith('[DEV SAMPLE]'))));
  const [editing, setEditing] = useState<Offering | 'new' | null>(null);
  const { run } = useAction();

  const groups = useMemo(() => {
    const m = new Map<string, Offering[]>();
    for (const o of offerings.data ?? []) m.set(o.division.name, [...(m.get(o.division.name) ?? []), o]);
    return [...m.entries()];
  }, [offerings.data]);

  const update = (o: Offering, body: Record<string, unknown>, msg: string) =>
    run(async () => {
      await patch(`/admin/services/${o.id}`, body);
      await offerings.reload();
    }, msg);

  return (
    <>
      <PageHead
        title="Rentals, property & entertainment"
        subtitle="Equipment rentals, properties for sale, entertainment passes and other bookable services."
        actions={<button className="btn primary" onClick={() => setEditing('new')}>+ Add listing</button>}
      />
      <Loading error={offerings.error} loading={offerings.loading && !offerings.data} />
      {offerings.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Listing</th><th>Pricing</th><th className="num">Price</th><th className="num">Deposit / caution</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {groups.length === 0 && <tr><td colSpan={6} className="empty">Nothing yet.</td></tr>}
              {groups.map(([div, list]) => [
                <tr className="group-row" key={`g-${div}`}><td colSpan={6}>{div} · {list.length}</td></tr>,
                ...list.map((o) => (
                  <tr key={o.id}>
                    <td><strong>{o.name}</strong>{o.description && <div className="muted small" style={{ maxWidth: 520 }}>{o.description}</div>}</td>
                    <td className="small">{PRICING[o.pricingType]}</td>
                    <td className="num">
                      {o.pricingType === 'QUOTE_REQUIRED' ? <span className="muted">—</span> : (
                        <InlinePrice minor={o.basePriceMinor ?? 0} onSave={(k) => update(o, { basePriceMinor: k }, `${o.name}: ${formatNaira(k)}`)} />
                      )}
                    </td>
                    <td className="num">{o.depositMinor ? formatNaira(o.depositMinor) : '—'}</td>
                    <td><StatusPill status={o.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td><div className="row-actions">
                      <button className="btn sm" onClick={() => setEditing(o)}>Edit</button>
                      <button className={`btn sm ${o.isActive ? 'danger' : ''}`} onClick={() => void update(o, { isActive: !o.isActive }, o.isActive ? `${o.name} removed` : `${o.name} restored`)}>
                        {o.isActive ? 'Remove' : 'Restore'}
                      </button>
                    </div></td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {editing && <OfferingForm offering={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void offerings.reload(); }} />}
    </>
  );
}

function OfferingForm({ offering, onClose, onSaved }: { offering?: Offering; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [division, setDivision] = useState(offering?.division.slug ?? DIVISIONS[0][0]);
  const [name, setName] = useState(offering?.name ?? '');
  const [description, setDescription] = useState(offering?.description ?? '');
  const [pricingType, setPricingType] = useState<Offering['pricingType']>(offering?.pricingType ?? 'FIXED');
  const [price, setPrice] = useState<number | null>(offering?.basePriceMinor ?? null);
  const [deposit, setDeposit] = useState<number | null>(offering?.depositMinor ?? null);
  const valid = name.trim().length >= 2 && (pricingType === 'QUOTE_REQUIRED' || price !== null);

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        name: name.trim(), description: description.trim() || undefined, pricingType,
        ...(price !== null ? { basePriceMinor: price } : {}), ...(deposit !== null ? { depositMinor: deposit } : {}),
      };
      if (offering) await patch(`/admin/services/${offering.id}`, body);
      else {
        const prefix = division.split('-').map((w) => w[0]).join('').toUpperCase();
        await post('/admin/services', { ...body, division, code: `${prefix}-${Date.now().toString(36).toUpperCase()}` });
      }
    }, 'Listing saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={offering ? `Edit ${offering.name}` : 'Add listing'}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        {!offering && (
          <Field label="Division" full>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              {DIVISIONS.map(([s, l]) => <option key={s} value={s}>{l}</option>)}
            </select>
          </Field>
        )}
        <Field label="Name" full><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" full><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Pricing">
          <select value={pricingType} onChange={(e) => setPricingType(e.target.value as Offering['pricingType'])}>
            {Object.entries(PRICING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Price (₦)"><MoneyInput value={price} onChange={setPrice} placeholder="—" /></Field>
        <Field label="Deposit / caution fee (₦)" hint="Optional"><MoneyInput value={deposit} onChange={setDeposit} placeholder="—" /></Field>
      </div>
    </Modal>
  );
}

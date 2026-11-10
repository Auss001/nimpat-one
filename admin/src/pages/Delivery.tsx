import { useState } from 'react';
import { get, patch, post } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, StatusPill, useAction, useConfirm, useLoad } from '../components/ui';
import { formatNaira } from '../money';

interface Zone {
  id: string;
  name: string;
  state: string;
  cities: string[];
  feeMinor: number;
  freeAboveMinor: number | null;
  estimatedHours: number | null;
  isActive: boolean;
  payOnDeliveryEnabled: boolean;
  verification: string;
}

const DIVISION = 'water-drinks-wines';

export function DeliveryPage() {
  const zones = useLoad(() => get<Zone[]>(`/admin/delivery/zones?division=${DIVISION}`));
  const [editing, setEditing] = useState<Zone | 'new' | null>(null);
  const { run, busy } = useAction();
  const { ask, dialog } = useConfirm();
  // Every shop that delivers gets the same rings; a shop this person cannot manage is skipped.
  const rings = () =>
    ask(
      'Set Abuja delivery fees in rings around Wuye for every shop? Wuye and Utako free; central areas ₦5,000; the middle ring ₦7,500; Gwarinpa, Kubwa and the far edges ₦10,000. Abuja areas not on the list pay ₦10,000. You can change any zone afterwards.',
      () => void run(async () => {
        const shops = ['water-drinks-wines', 'pharmacy-laboratory', 'retail-general-supplies'];
        const results = await Promise.allSettled(shops.map((division) => post('/admin/delivery/abuja-rings', { division })));
        if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
        await zones.reload();
      }, 'Abuja ring fees are set and live'),
      'Set ring fees',
    );

  return (
    <>
      <PageHead
        title="Delivery fees"
        subtitle="Water, Drinks & Wines delivery areas. A zone that lists cities is used before a whole-state zone."
        actions={<><button className="btn" disabled={busy} onClick={rings}>Set Abuja ring fees</button><button className="btn primary" onClick={() => setEditing('new')}>+ Add zone</button></>}
      />
      <Loading error={zones.error} loading={zones.loading && !zones.data} />
      {zones.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Zone</th><th>State</th><th>Cities / areas</th><th className="num">Fee</th><th className="num">Free above</th><th className="num">Delivery time</th><th>Pay on delivery</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {zones.data.length === 0 && <tr><td colSpan={9} className="empty">No zones yet — customers cannot choose delivery.</td></tr>}
              {zones.data.map((z) => (
                <tr key={z.id}>
                  <td><strong>{z.name}</strong></td>
                  <td>{z.state}</td>
                  <td className="small">{z.cities.length ? z.cities.join(', ') : <span className="muted">Whole state</span>}</td>
                  <td className="num">{formatNaira(z.feeMinor)}</td>
                  <td className="num">{z.freeAboveMinor !== null ? formatNaira(z.freeAboveMinor) : '—'}</td>
                  <td className="num">{z.estimatedHours ? `${z.estimatedHours} h` : '—'}</td>
                  <td className="small">{z.payOnDeliveryEnabled ? 'Allowed' : 'Off'}</td>
                  <td><StatusPill status={z.isActive ? 'ACTIVE' : 'INACTIVE'} />{z.verification !== 'VERIFIED' && <div className="muted small">{z.verification === 'DEV_SAMPLE' ? 'sample, not charged' : 'unconfirmed, not charged'}</div>}</td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setEditing(z)}>Edit</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog}
      {editing && <ZoneForm zone={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void zones.reload(); }} />}
    </>
  );
}

function ZoneForm({ zone, onClose, onSaved }: { zone?: Zone; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(zone?.name ?? '');
  const [state, setState] = useState(zone?.state ?? 'FCT');
  const [cities, setCities] = useState(zone?.cities.join(', ') ?? '');
  const [fee, setFee] = useState<number | null>(zone?.feeMinor ?? null);
  const [freeAbove, setFreeAbove] = useState<number | null>(zone?.freeAboveMinor ?? null);
  const [hours, setHours] = useState(zone?.estimatedHours ? String(zone.estimatedHours) : '');
  const [active, setActive] = useState(zone?.isActive ?? true);
  const [pod, setPod] = useState(zone?.payOnDeliveryEnabled ?? false);
  const valid = name.trim().length >= 2 && state.trim().length >= 2 && fee !== null;

  const save = () =>
    run(async () => {
      const body = {
        name: name.trim(),
        state: state.trim(),
        cities: cities.split(',').map((c) => c.trim()).filter(Boolean),
        feeMinor: fee,
        ...(freeAbove !== null ? { freeAboveMinor: freeAbove } : {}),
        ...(hours ? { estimatedHours: Number(hours) } : {}),
        isActive: active,
        payOnDeliveryEnabled: pod,
      };
      if (zone) await patch(`/admin/delivery/zones/${zone.id}`, body);
      else await post('/admin/delivery/zones', { ...body, division: DIVISION });
    }, 'Delivery zone saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={zone ? `Edit ${zone.name}` : 'Add delivery zone'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Zone name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Abuja central" /></Field>
        <Field label="State"><input value={state} onChange={(e) => setState(e.target.value)} placeholder="FCT" /></Field>
        <Field label="Cities / areas" hint="Comma-separated. Leave empty to cover the whole state." full>
          <input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Wuye, Maitama, Garki" />
        </Field>
        <Field label="Delivery fee (₦)"><MoneyInput value={fee} onChange={setFee} /></Field>
        <Field label="Free delivery above (₦)" hint="Optional"><MoneyInput value={freeAbove} onChange={setFreeAbove} placeholder="—" /></Field>
        <Field label="Delivery time (hours)"><input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Status"><label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label></Field>
        <Field label="Pay on delivery" hint="The department's payment rules must allow it too"><label className="check"><input type="checkbox" checked={pod} onChange={(e) => setPod(e.target.checked)} /> Allow in this zone</label></Field>
      </div>
    </Modal>
  );
}

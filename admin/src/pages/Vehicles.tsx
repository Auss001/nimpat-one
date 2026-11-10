import { useState } from 'react';
import { get, patch, post } from '../api';
import { BulkPhotoUpload, PhotoManager, type PhotoTarget } from '../components/PhotoManager';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, StatusPill, useAction, useLoad } from '../components/ui';
import { formatNaira, slugify } from '../money';

type VStatus = 'DRAFT' | 'AVAILABLE' | 'RESERVED' | 'SOLD' | 'ARCHIVED';
interface Vehicle {
  id: string;
  slug: string;
  make: string;
  model: string;
  year: number;
  trim: string | null;
  condition: 'BRAND_NEW' | 'FOREIGN_USED' | 'NIGERIAN_USED' | null;
  transmission: string | null;
  fuelType: string | null;
  colour: string | null;
  mileageKm: number | null;
  priceMinor: number | null;
  depositMinor: number | null;
  customsCleared: boolean;
  description: string | null;
  status: VStatus;
  images: { url: string }[];
}
const CONDITION = { BRAND_NEW: 'Brand new', FOREIGN_USED: 'Foreign used', NIGERIAN_USED: 'Nigerian used' };

export function VehiclesPage() {
  const vehicles = useLoad(() => get<{ data: Vehicle[] }>('/admin/vehicles?pageSize=100').then((r) => r.data.filter((v) => v.make !== 'DevSample' && v.status !== 'ARCHIVED')));
  const [editing, setEditing] = useState<Vehicle | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [photos, setPhotos] = useState<PhotoTarget | null>(null);
  const { run } = useAction();

  const savePrice = (v: Vehicle, kobo: number) =>
    run(async () => {
      await patch(`/admin/vehicles/${v.id}`, { priceMinor: kobo });
      await vehicles.reload();
    }, `${v.make} ${v.model}: ${formatNaira(kobo)}`);

  return (
    <>
      <PageHead
        title="Automobiles"
        subtitle="Showroom vehicles. Customers book inspections or test drives; set a deposit to allow an online deposit hold."
        actions={<><button className="btn" onClick={() => setBulk(true)}>Upload photos & details</button><button className="btn primary" onClick={() => setEditing('new')}>+ Add vehicle</button></>}
      />
      <Loading error={vehicles.error} loading={vehicles.loading && !vehicles.data} />
      {bulk && <BulkPhotoUpload cars onClose={() => setBulk(false)} onChanged={() => void vehicles.reload()} />}
      {vehicles.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th style={{ width: 70 }}></th><th>Vehicle</th><th>Condition</th><th className="num">Mileage</th><th className="num">Price</th><th className="num">Deposit</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {vehicles.data.length === 0 && <tr><td colSpan={8} className="empty">No vehicles yet.</td></tr>}
              {vehicles.data.map((v) => (
                <tr key={v.id}>
                  <td>{v.images[0] ? <img className="thumb" style={{ width: 60 }} src={v.images[0].url} alt="" /> : <div className="thumb" />}</td>
                  <td><strong>{v.year} {v.make} {v.model}</strong><div className="muted small">{[v.colour, v.transmission?.toLowerCase(), v.fuelType?.toLowerCase(), v.customsCleared ? 'customs cleared' : null].filter(Boolean).join(' · ')}</div></td>
                  <td>{v.condition ? CONDITION[v.condition] : <span className="muted">Not stated</span>}</td>
                  <td className="num">{v.mileageKm !== null ? `${v.mileageKm.toLocaleString()} km` : '—'}</td>
                  <td className="num"><InlinePrice minor={v.priceMinor} onSave={(k) => savePrice(v, k)} /></td>
                  <td className="num">{v.depositMinor ? formatNaira(v.depositMinor) : <span className="muted">None</span>}</td>
                  <td><StatusPill status={v.status} /></td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setEditing(v)}>Edit</button><button className="btn sm" onClick={() => setPhotos({ owner: 'vehicle', id: v.id })}>Photos</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {photos && <PhotoManager {...photos} onClose={() => setPhotos(null)} onChanged={() => void vehicles.reload()} />}
      {editing && <VehicleForm vehicle={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void vehicles.reload(); }} />}
    </>
  );
}

function VehicleForm({ vehicle, onClose, onSaved }: { vehicle?: Vehicle; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    make: vehicle?.make ?? '', model: vehicle?.model ?? '', year: String(vehicle?.year ?? new Date().getFullYear()), trim: vehicle?.trim ?? '',
    condition: vehicle ? vehicle.condition ?? '' : 'BRAND_NEW', transmission: vehicle?.transmission ?? 'AUTOMATIC', fuelType: vehicle?.fuelType ?? 'PETROL',
    colour: vehicle?.colour ?? '', mileageKm: vehicle?.mileageKm !== null && vehicle?.mileageKm !== undefined ? String(vehicle.mileageKm) : '',
    description: vehicle?.description ?? '', status: vehicle?.status ?? ('AVAILABLE' as VStatus),
  });
  const [customs, setCustoms] = useState(vehicle?.customsCleared ?? false);
  const [price, setPrice] = useState<number | null>(vehicle?.priceMinor ?? null);
  const [deposit, setDeposit] = useState<number | null>(vehicle?.depositMinor ?? null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = f.make.trim() && f.model.trim() && /^\d{4}$/.test(f.year) && (price === null || price > 0) && (deposit === null || deposit > 0);

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        make: f.make.trim(), model: f.model.trim(), year: Number(f.year), trim: f.trim || undefined, condition: f.condition || null,
        transmission: f.transmission || undefined, fuelType: f.fuelType || undefined, colour: f.colour || undefined,
        mileageKm: f.mileageKm ? Number(f.mileageKm) : undefined, description: f.description || undefined, status: f.status,
        customsCleared: customs, priceMinor: price, ...(deposit !== null ? { depositMinor: deposit } : {}),
      };
      if (vehicle) await patch(`/admin/vehicles/${vehicle.id}`, body);
      else await post('/admin/vehicles', { ...body, slug: `${slugify(`${f.year} ${f.make} ${f.model}`)}-${Date.now().toString(36)}` });
    }, 'Vehicle saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={vehicle ? `Edit ${vehicle.year} ${vehicle.make} ${vehicle.model}` : 'Add vehicle'}
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Make"><input value={f.make} onChange={set('make')} /></Field>
        <Field label="Model"><input value={f.model} onChange={set('model')} /></Field>
        <Field label="Year"><input inputMode="numeric" value={f.year} onChange={set('year')} /></Field>
        <Field label="Trim"><input value={f.trim} onChange={set('trim')} /></Field>
        <Field label="Condition">
          <select value={f.condition} onChange={set('condition')}>
            <option value="">Not stated</option>
            {Object.entries(CONDITION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Mileage (km)"><input inputMode="numeric" value={f.mileageKm} onChange={(e) => setF({ ...f, mileageKm: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Transmission"><input value={f.transmission} onChange={set('transmission')} /></Field>
        <Field label="Fuel"><input value={f.fuelType} onChange={set('fuelType')} /></Field>
        <Field label="Colour"><input value={f.colour} onChange={set('colour')} /></Field>
        <Field label="Customs"><label className="check"><input type="checkbox" checked={customs} onChange={(e) => setCustoms(e.target.checked)} /> Customs duty fully paid</label></Field>
        <Field label="Price (₦)"><MoneyInput value={price} onChange={setPrice} /></Field>
        <Field label="Online deposit (₦)" hint="Leave empty to disable deposit holds"><MoneyInput value={deposit} onChange={setDeposit} placeholder="—" /></Field>
        <Field label="Description" full><textarea value={f.description} onChange={set('description')} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            <option value="AVAILABLE">Available</option><option value="RESERVED">Reserved</option><option value="SOLD">Sold</option>
            <option value="DRAFT">Draft (hidden)</option><option value="ARCHIVED">Archived (removed)</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

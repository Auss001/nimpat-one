import { useMemo, useState } from 'react';
import { get, patch, post, put } from '../api';
import { Field, Loading, Modal, MoneyInput, PageHead, Pill, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira } from '../money';

const words = (s?: string | null) => (s ?? '').replace(/_/g, ' ').toLowerCase();

const DIVISIONS: [string, string][] = [
  ['water-drinks-wines', 'Water, Drinks & Wines'],
  ['luxury-apartments', 'Luxury Apartments'],
  ['automobiles', 'Automobiles'],
  ['spa-wellness', 'Spa & Wellness'],
  ['transport-logistics', 'Transport & Logistics'],
  ['retail-general-supplies', 'Retail & Supplies'],
  ['media-events-rentals', 'Media, Events & Rentals'],
  ['real-estate-interior-design', 'Real Estate & Interior'],
  ['entertainment', 'Entertainment'],
];

export function PaymentSettingsPage() {
  const [tab, setTab] = useState<'policies' | 'accounts' | 'locations'>('policies');
  return (
    <>
      <PageHead title="Payment settings" subtitle="Paystack is the only online gateway. Choose which methods, deposits and confirmation rules each department uses." />
      <div className="toolbar">
        <Tabs value={tab} onChange={setTab} options={[{ value: 'policies', label: 'Payment rules' }, { value: 'accounts', label: 'Bank accounts' }, { value: 'locations', label: 'Service locations' }]} />
      </div>
      {tab === 'policies' && <Policies />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'locations' && <Locations />}
    </>
  );
}

function Policies() {
  const policies = useLoad(() => get<any[]>('/admin/payment-settings/policies'));
  const [division, setDivision] = useState('water-drinks-wines');
  const [editing, setEditing] = useState<any | null>(null);
  const rows = useMemo(() => (policies.data ?? []).filter((p) => p.division.slug === division), [policies.data, division]);
  return (
    <>
      <div className="toolbar">
        <select style={{ width: 'auto' }} aria-label="Department" value={division} onChange={(e) => setDivision(e.target.value)}>
          {DIVISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <Loading error={policies.error} loading={policies.loading && !policies.data} />
      {policies.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Transaction</th><th>Methods</th><th>Deposit</th><th>Confirmed when</th><th className="num">Transfer window</th><th></th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.purpose}>
                  <td><strong>{words(p.purpose)}</strong>{!p.configured && <div className="muted small">default rules</div>}</td>
                  <td>
                    {p.allowPaystack && <Pill tone="orange">Paystack</Pill>}{' '}
                    {p.allowBankTransfer && <Pill tone="blue">Bank transfer</Pill>}{' '}
                    {p.allowPayOnDelivery && <Pill tone="green">On delivery</Pill>}{' '}
                    {p.allowPayAtLocation && <Pill tone="amber">At location</Pill>}
                  </td>
                  <td className="small">{p.depositType === 'PERCENT' ? `${p.depositPercentBps / 100}%` : p.depositType === 'FIXED' ? formatNaira(p.depositFixedMinor) : 'None'}</td>
                  <td className="small">{words(p.confirmationRule)}</td>
                  <td className="num">{p.bankTransferWindowHours} h</td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setEditing(p)}>Edit</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PolicyForm policy={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void policies.reload(); }} />}
    </>
  );
}

function PolicyForm({ policy, onClose, onSaved }: { policy: any; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    allowPaystack: policy.allowPaystack, allowBankTransfer: policy.allowBankTransfer, allowPayOnDelivery: policy.allowPayOnDelivery, allowPayAtLocation: policy.allowPayAtLocation,
    depositType: policy.depositType as string, percent: policy.depositPercentBps ? String(policy.depositPercentBps / 100) : '', confirmationRule: policy.confirmationRule as string, window: String(policy.bankTransferWindowHours),
  });
  const [fixed, setFixed] = useState<number | null>(policy.depositFixedMinor);
  const [podMin, setPodMin] = useState<number | null>(policy.payOnDeliveryMinOrderMinor);
  const [podMax, setPodMax] = useState<number | null>(policy.payOnDeliveryMaxOrderMinor);
  const isOrder = policy.purpose === 'ORDER';
  const bps = Math.round(Number(f.percent) * 100);
  const valid = Number(f.window) >= 1 && Number(f.window) <= 336 && (f.depositType !== 'PERCENT' || (bps > 0 && bps <= 10000)) && (f.depositType !== 'FIXED' || (fixed ?? 0) > 0);
  const toggle = (k: 'allowPaystack' | 'allowBankTransfer' | 'allowPayOnDelivery' | 'allowPayAtLocation') => setF({ ...f, [k]: !f[k] });
  const save = () =>
    run(() => put(`/admin/payment-settings/policies/${policy.division.slug}/${policy.purpose}`, {
      allowPaystack: f.allowPaystack, allowBankTransfer: f.allowBankTransfer, allowPayOnDelivery: isOrder ? f.allowPayOnDelivery : false, allowPayAtLocation: f.allowPayAtLocation,
      depositType: f.depositType,
      depositPercentBps: f.depositType === 'PERCENT' ? bps : null,
      depositFixedMinor: f.depositType === 'FIXED' ? fixed : null,
      confirmationRule: f.confirmationRule,
      bankTransferWindowHours: Number(f.window),
      ...(isOrder ? { payOnDeliveryMinOrderMinor: podMin, payOnDeliveryMaxOrderMinor: podMax } : {}),
    }), 'Payment rules saved').then((ok) => ok && onSaved());
  return (
    <Modal title={`${policy.division.name}: ${words(policy.purpose)}`} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}>
      <div className="form-grid">
        <Field label="Methods customers can use" full>
          <label className="check"><input type="checkbox" checked={f.allowPaystack} onChange={() => toggle('allowPaystack')} /> Paystack (card, bank transfer, USSD)</label>
          <label className="check"><input type="checkbox" checked={f.allowBankTransfer} onChange={() => toggle('allowBankTransfer')} /> Direct transfer to a Nimpat bank account</label>
          {isOrder && <label className="check"><input type="checkbox" checked={f.allowPayOnDelivery} onChange={() => toggle('allowPayOnDelivery')} /> Pay on delivery (also switch it on per delivery zone)</label>}
          <label className="check"><input type="checkbox" checked={f.allowPayAtLocation} onChange={() => toggle('allowPayAtLocation')} /> Pay at a service location</label>
        </Field>
        {isOrder && (
          <>
            <Field label="Pay on delivery: minimum order (₦)"><MoneyInput value={podMin} onChange={setPodMin} placeholder="None" /></Field>
            <Field label="Pay on delivery: maximum order (₦)"><MoneyInput value={podMax} onChange={setPodMax} placeholder="None" /></Field>
          </>
        )}
        <Field label="Deposit">
          <select value={f.depositType} onChange={(e) => setF({ ...f, depositType: e.target.value })}>
            <option value="NONE">No deposit</option><option value="PERCENT">Percentage of total</option><option value="FIXED">Fixed amount</option>
          </select>
        </Field>
        {f.depositType === 'PERCENT' && <Field label="Deposit percentage"><input inputMode="decimal" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} placeholder="30" /></Field>}
        {f.depositType === 'FIXED' && <Field label="Deposit amount (₦)"><MoneyInput value={fixed} onChange={setFixed} /></Field>}
        <Field label="Confirm the order or booking when">
          <select value={f.confirmationRule} onChange={(e) => setF({ ...f, confirmationRule: e.target.value })}>
            <option value="FULL_PAYMENT">Paid in full (verified)</option>
            <option value="DEPOSIT_VERIFIED">Deposit verified</option>
            <option value="STAFF_APPROVAL">Staff approve it</option>
          </select>
        </Field>
        <Field label="Bank transfer window (hours)" hint="How long to hold stock or dates while waiting for a transfer"><input inputMode="numeric" value={f.window} onChange={(e) => setF({ ...f, window: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
    </Modal>
  );
}

function Accounts() {
  const accounts = useLoad(() => get<any[]>('/admin/payment-settings/bank-accounts'));
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  return (
    <>
      <div className="toolbar"><span style={{ flex: 1 }} className="muted small">Customers see only the bank, account name and number of the account for their department, after choosing bank transfer.</span><button className="btn primary" onClick={() => setEditing('new')}>+ Add account</button></div>
      <Loading error={accounts.error} loading={accounts.loading && !accounts.data} />
      {accounts.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Label</th><th>Department</th><th>Bank</th><th>Account name</th><th>Number</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {accounts.data.length === 0 && <tr><td colSpan={7} className="empty">No bank accounts yet, so customers cannot pay by direct transfer.</td></tr>}
              {accounts.data.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.label}</strong></td>
                  <td className="small">{a.division?.name ?? 'All departments'}</td>
                  <td>{a.bankName}</td>
                  <td>{a.accountName}</td>
                  <td className="mono">{a.accountNumber}</td>
                  <td><StatusPill status={a.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setEditing(a)}>Edit</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <AccountForm account={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void accounts.reload(); }} />}
    </>
  );
}

function AccountForm({ account, onClose, onSaved }: { account?: any; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ division: '', label: account?.label ?? '', bankName: account?.bankName ?? '', accountName: account?.accountName ?? '', accountNumber: account?.accountNumber ?? '', isActive: account?.isActive ?? true });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = f.label.trim().length >= 2 && f.bankName.trim().length >= 2 && f.accountName.trim().length >= 2 && /^\d{10}$/.test(f.accountNumber);
  const save = () =>
    run(async () => {
      const { division, ...rest } = f;
      if (account) await patch(`/admin/payment-settings/bank-accounts/${account.id}`, rest);
      else await post('/admin/payment-settings/bank-accounts', { ...rest, ...(division ? { division } : {}) });
    }, 'Bank account saved').then((ok) => ok && onSaved());
  return (
    <Modal title={account ? `Edit ${account.label}` : 'Add bank account'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}>
      <div className="form-grid">
        <Field label="Label" full><input value={f.label} onChange={set('label')} /></Field>
        {!account && (
          <Field label="Department" full>
            <select value={f.division} onChange={set('division')}>
              <option value="">All departments (default)</option>
              {DIVISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        )}
        <Field label="Bank"><input value={f.bankName} onChange={set('bankName')} /></Field>
        <Field label="Account name"><input value={f.accountName} onChange={set('accountName')} /></Field>
        <Field label="Account number (10 digits)"><input inputMode="numeric" maxLength={10} value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Status"><label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label></Field>
      </div>
    </Modal>
  );
}

function Locations() {
  const locations = useLoad(() => get<any[]>('/admin/payment-settings/service-locations'));
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  return (
    <>
      <div className="toolbar"><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setEditing('new')}>+ Add location</button></div>
      <Loading error={locations.error} loading={locations.loading && !locations.data} />
      {locations.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Location</th><th>Department</th><th>Address</th><th>Accepts</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {locations.data.length === 0 && <tr><td colSpan={6} className="empty">No locations yet, so customers cannot pay in person.</td></tr>}
              {locations.data.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong><div className="muted small mono">{l.code}</div></td>
                  <td className="small">{l.division.name}</td>
                  <td className="small">{l.addressLine}, {l.city}, {l.state}</td>
                  <td>{l.acceptsCash && <Pill>Cash</Pill>} {l.acceptsBankTransfer && <Pill>Transfer</Pill>} {l.acceptsCardTerminal && <Pill>Terminal</Pill>}</td>
                  <td><StatusPill status={l.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td><div className="row-actions"><button className="btn sm" onClick={() => setEditing(l)}>Edit</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <LocationForm location={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void locations.reload(); }} />}
    </>
  );
}

function LocationForm({ location, onClose, onSaved }: { location?: any; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    division: location?.division.slug ?? 'spa-wellness', code: location?.code ?? '', name: location?.name ?? '', addressLine: location?.addressLine ?? '', city: location?.city ?? 'Abuja', state: location?.state ?? 'FCT',
    acceptsCash: location?.acceptsCash ?? true, acceptsBankTransfer: location?.acceptsBankTransfer ?? true, acceptsCardTerminal: location?.acceptsCardTerminal ?? false, isActive: location?.isActive ?? true,
  });
  const set = (k: 'division' | 'code' | 'name' | 'addressLine' | 'city' | 'state') => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'code' ? e.target.value.toUpperCase() : e.target.value });
  const valid = /^[A-Z0-9][A-Z0-9-]{2,39}$/.test(f.code) && f.name.trim().length >= 2 && f.addressLine.trim().length >= 3 && f.city.trim().length >= 2 && f.state.trim().length >= 2;
  const save = () =>
    run(async () => {
      if (location) {
        const { division, ...rest } = f;
        void division;
        await patch(`/admin/payment-settings/service-locations/${location.id}`, rest);
      } else await post('/admin/payment-settings/service-locations', f);
    }, 'Location saved').then((ok) => ok && onSaved());
  return (
    <Modal title={location ? `Edit ${location.name}` : 'Add service location'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}>
      <div className="form-grid">
        {!location && (
          <Field label="Department" full>
            <select value={f.division} onChange={set('division')}>{DIVISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
        )}
        <Field label="Name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Code" hint="Capital letters, numbers, dashes"><input value={f.code} onChange={set('code')} placeholder="SPA-WUYE" /></Field>
        <Field label="Address" full><input value={f.addressLine} onChange={set('addressLine')} /></Field>
        <Field label="City"><input value={f.city} onChange={set('city')} /></Field>
        <Field label="State"><input value={f.state} onChange={set('state')} /></Field>
        <Field label="Accepts" hint="Card terminal payments are recorded by hand; no terminal is connected" full>
          <label className="check"><input type="checkbox" checked={f.acceptsCash} onChange={(e) => setF({ ...f, acceptsCash: e.target.checked })} /> Cash</label>
          <label className="check"><input type="checkbox" checked={f.acceptsBankTransfer} onChange={(e) => setF({ ...f, acceptsBankTransfer: e.target.checked })} /> Bank transfer</label>
          <label className="check"><input type="checkbox" checked={f.acceptsCardTerminal} onChange={(e) => setF({ ...f, acceptsCardTerminal: e.target.checked })} /> Card terminal</label>
        </Field>
        <Field label="Status"><label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label></Field>
      </div>
    </Modal>
  );
}

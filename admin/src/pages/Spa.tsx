import { useMemo, useState } from 'react';
import { get, patch, post } from '../api';
import { Field, InlinePrice, Loading, Modal, MoneyInput, PageHead, StatusPill, Tabs, useAction, useLoad } from '../components/ui';
import { formatNaira, slugify } from '../money';

interface Treatment {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  description: string | null;
  durationMinutes: number;
  priceMinor: number;
  depositMinor: number;
  isActive: boolean;
  _count: { practitioners: number };
}
interface Therapist {
  id: string;
  displayName: string;
  bio: string | null;
  isActive: boolean;
  treatments: { treatmentId: string }[];
}

export function SpaPage() {
  const [tab, setTab] = useState<'menu' | 'therapists'>('menu');
  const treatments = useLoad(() => get<Treatment[]>('/admin/spa/treatments').then((r) => r.filter((t) => !t.name.startsWith('[DEV SAMPLE]'))));
  const therapists = useLoad(() => get<Therapist[]>('/admin/spa/practitioners').then((r) => r.filter((t) => !t.displayName.startsWith('[DEV SAMPLE]'))));
  const activeTherapists = (therapists.data ?? []).filter((t) => t.isActive);

  return (
    <>
      <PageHead
        title="Spa & Wellness"
        subtitle="Service menu, prices and the therapists who can perform each treatment."
        actions={<Tabs value={tab} onChange={setTab} options={[{ value: 'menu', label: 'Service menu' }, { value: 'therapists', label: 'Therapists' }]} />}
      />
      {therapists.data && activeTherapists.length === 0 && (
        <div className="banner warn">
          No active therapists yet, so customers cannot book online. Add therapists on the <strong>Therapists</strong> tab and choose what they offer.
        </div>
      )}
      {tab === 'menu' ? (
        <Menu treatments={treatments} />
      ) : (
        <Therapists therapists={therapists} treatments={treatments.data ?? []} onChanged={() => void treatments.reload()} />
      )}
    </>
  );
}

function Menu({ treatments }: { treatments: ReturnType<typeof useLoad<Treatment[]>> }) {
  const [editing, setEditing] = useState<Treatment | 'new' | null>(null);
  const [q, setQ] = useState('');
  const { run } = useAction();
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const m = new Map<string, Treatment[]>();
    for (const t of treatments.data ?? []) {
      if (term && !t.name.toLowerCase().includes(term)) continue;
      const k = t.category ?? 'Other';
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [treatments.data, q]);

  const update = (t: Treatment, body: Partial<Treatment>, msg: string) =>
    run(async () => {
      await patch(`/admin/spa/treatments/${t.id}`, body);
      await treatments.reload();
    }, msg);

  return (
    <>
      <div className="toolbar">
        <input className="search" placeholder="Search treatments" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{treatments.data?.length ?? 0} treatments</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setEditing('new')}>+ Add treatment</button>
      </div>
      <Loading error={treatments.error} loading={treatments.loading && !treatments.data} />
      {treatments.data && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Treatment</th><th className="num">Duration</th><th className="num">Price</th><th className="num">Online deposit</th><th className="num">Therapists</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {groups.map(([cat, list]) => [
                <tr className="group-row" key={`g-${cat}`}><td colSpan={7}>{cat} · {list.length}</td></tr>,
                ...list.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong></td>
                    <td className="num">{t.durationMinutes} min</td>
                    <td className="num"><InlinePrice minor={t.priceMinor} onSave={(k) => update(t, { priceMinor: k }, `${t.name}: ${formatNaira(k)}`)} /></td>
                    <td className="num">{t.depositMinor ? formatNaira(t.depositMinor) : <span className="muted">Pay at spa</span>}</td>
                    <td className="num">{t._count.practitioners || <span className="muted">0</span>}</td>
                    <td><StatusPill status={t.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td>
                      <div className="row-actions">
                        <button className="btn sm" onClick={() => setEditing(t)}>Edit</button>
                        <button className={`btn sm ${t.isActive ? 'danger' : ''}`} onClick={() => void update(t, { isActive: !t.isActive }, t.isActive ? `${t.name} removed from the menu` : `${t.name} is back on the menu`)}>
                          {t.isActive ? 'Remove' : 'Restore'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TreatmentForm
          treatment={editing === 'new' ? undefined : editing}
          categories={[...new Set((treatments.data ?? []).map((t) => t.category).filter(Boolean) as string[])]}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void treatments.reload(); }}
        />
      )}
    </>
  );
}

function TreatmentForm({ treatment, categories, onClose, onSaved }: { treatment?: Treatment; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(treatment?.name ?? '');
  const [category, setCategory] = useState(treatment?.category ?? categories[0] ?? '');
  const [description, setDescription] = useState(treatment?.description ?? '');
  const [duration, setDuration] = useState(String(treatment?.durationMinutes ?? 60));
  const [price, setPrice] = useState<number | null>(treatment?.priceMinor ?? null);
  const [deposit, setDeposit] = useState<number | null>(treatment?.depositMinor ?? 0);
  const valid = name.trim().length >= 2 && Number(duration) >= 15 && price !== null && deposit !== null && deposit <= price;

  const save = () =>
    run(async () => {
      const body = { name: name.trim(), category: category.trim() || undefined, description: description.trim() || undefined, durationMinutes: Number(duration), priceMinor: price, depositMinor: deposit };
      if (treatment) await patch(`/admin/spa/treatments/${treatment.id}`, body);
      else await post('/admin/spa/treatments', { ...body, slug: `${slugify(name)}-${Date.now().toString(36)}` });
    }, 'Treatment saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={treatment ? `Edit ${treatment.name}` : 'Add treatment'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Treatment name" full><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Category">
          <input list="spa-categories" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="spa-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Duration (minutes)"><input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Price (₦)"><MoneyInput value={price} onChange={setPrice} /></Field>
        <Field label="Online deposit (₦)" hint="0 = customer pays at the spa"><MoneyInput value={deposit} onChange={setDeposit} /></Field>
        <Field label="Description" full><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function Therapists({ therapists, treatments, onChanged }: { therapists: ReturnType<typeof useLoad<Therapist[]>>; treatments: Treatment[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<Therapist | 'new' | null>(null);
  const { run } = useAction();
  const toggle = (t: Therapist) =>
    run(async () => {
      await patch(`/admin/spa/practitioners/${t.id}`, { isActive: !t.isActive });
      await therapists.reload();
    }, t.isActive ? `${t.displayName} switched off` : `${t.displayName} is available again`);

  return (
    <>
      <div className="toolbar">
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setEditing('new')}>+ Add therapist</button>
      </div>
      <Loading error={therapists.error} loading={therapists.loading && !therapists.data} />
      {therapists.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Therapist</th><th className="num">Treatments offered</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {therapists.data.length === 0 && <tr><td colSpan={4} className="empty">No therapists yet.</td></tr>}
              {therapists.data.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.displayName}</strong>{t.bio && <div className="muted small">{t.bio}</div>}</td>
                  <td className="num">{t.treatments.length}</td>
                  <td><StatusPill status={t.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td><div className="row-actions">
                    <button className="btn sm" onClick={() => setEditing(t)}>Edit</button>
                    <button className={`btn sm ${t.isActive ? 'danger' : ''}`} onClick={() => void toggle(t)}>{t.isActive ? 'Switch off' : 'Switch on'}</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TherapistForm
          therapist={editing === 'new' ? undefined : editing}
          treatments={treatments.filter((t) => t.isActive)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void therapists.reload(); onChanged(); }}
        />
      )}
    </>
  );
}

function TherapistForm({ therapist, treatments, onClose, onSaved }: { therapist?: Therapist; treatments: Treatment[]; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(therapist?.displayName ?? '');
  const [bio, setBio] = useState(therapist?.bio ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(therapist?.treatments.map((t) => t.treatmentId) ?? []));
  const byCat = useMemo(() => {
    const m = new Map<string, Treatment[]>();
    for (const t of treatments) m.set(t.category ?? 'Other', [...(m.get(t.category ?? 'Other') ?? []), t]);
    return [...m.entries()];
  }, [treatments]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleCat = (list: Treatment[], on: boolean) => setSelected((s) => { const n = new Set(s); list.forEach((t) => (on ? n.add(t.id) : n.delete(t.id))); return n; });
  const valid = name.trim().length >= 2;

  const save = () =>
    run(async () => {
      const body = { displayName: name.trim(), bio: bio.trim() || undefined, treatmentIds: [...selected] };
      if (therapist) await patch(`/admin/spa/practitioners/${therapist.id}`, body);
      else await post('/admin/spa/practitioners', body);
    }, 'Therapist saved').then((ok) => ok && onSaved());

  return (
    <Modal
      title={therapist ? `Edit ${therapist.displayName}` : 'Add therapist'}
      onClose={onClose}
      wide
      footer={<><span className="muted small" style={{ marginRight: 'auto' }}>{selected.size} treatments selected</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Save</button></>}
    >
      <div className="form-grid">
        <Field label="Name shown to customers"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Short bio (optional)"><input value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>Treatments this therapist performs</h3>
        {byCat.map(([cat, list]) => {
          const all = list.every((t) => selected.has(t.id));
          return (
            <div key={cat} style={{ marginBottom: 10 }}>
              <label className="check" style={{ fontWeight: 650 }}>
                <input type="checkbox" checked={all} onChange={(e) => toggleCat(list, e.target.checked)} /> {cat}
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 12px', paddingLeft: 24 }}>
                {list.map((t) => (
                  <label key={t.id} className="check small"><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} /> {t.name}</label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

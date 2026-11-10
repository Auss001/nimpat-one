import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { post, upload } from '../api';
import { Modal, Pill, Tabs, useToast } from './ui';

type Action = 'change' | 'same' | 'missing';
interface Row {
  key: string;
  sku: string;
  productId: string | null;
  currentName: string | null;
  currentDescription: string | null;
  name: string | null;
  description: string | null;
  action: Action;
}
interface Preview {
  fileName: string;
  summary: Record<Action | 'rows', number>;
  rows: Row[];
}

/**
 * Product names and descriptions from a sheet (SKU, Name, Description). Shows old and new
 * text side by side; nothing changes until the ticked rows are applied.
 */
export function DetailsUpload({ division, title, onClose, onChanged }: { division: string; title: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<'all' | Action>('change');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  // A sheet prepared outside the dashboard for this store, shipped with it for one use.
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    fetch(`/prepared/details/${division}.csv`, { method: 'HEAD' }).then((r) => setPrepared(r.ok && !(r.headers.get('content-type') ?? '').includes('html'))).catch(() => setPrepared(false));
  }, [division]);

  const read = async (file: File) => {
    setBusy('Reading…');
    setError(null);
    setDone(null);
    try {
      const p = await upload<Preview>('/admin/catalog/details/preview', file, { division });
      setPreview(p);
      setTicked(new Set(p.rows.filter((r) => r.action === 'change').map((r) => r.key)));
      setShow(p.summary.change ? 'change' : 'all');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void read(f);
  };
  const usePrepared = async () => {
    const r = await fetch(`/prepared/details/${division}.csv`);
    if (r.ok) await read(new File([await r.blob()], `${division}-write-ups.csv`, { type: 'text/csv' }));
  };

  const rows = useMemo(() => (preview?.rows ?? []).filter((r) => show === 'all' || r.action === show), [preview, show]);
  const chosen = (preview?.rows ?? []).filter((r) => ticked.has(r.key) && r.productId && r.action === 'change');
  const toggle = (k: string) => setTicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const apply = async () => {
    if (!preview || !chosen.length) return;
    setBusy('Applying…');
    setError(null);
    try {
      const r = await post<{ updated: number }>('/admin/catalog/details/apply', {
        division,
        fileName: preview.fileName,
        items: chosen.map((x) => ({ productId: x.productId, ...(x.name ? { name: x.name } : {}), ...(x.description ? { description: x.description } : {}) })),
      });
      setDone(r.updated);
      setPreview(null);
      toast(`${r.updated} products updated`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal
      title={`Names & descriptions: ${title}`}
      onClose={() => { if (!busy) onClose(); }}
      wide
      footer={preview
        ? <><button className="btn" disabled={!!busy} onClick={() => setPreview(null)}>Back</button><button className="btn primary" disabled={!!busy || !chosen.length} onClick={() => void apply()}>{busy === 'Applying…' ? busy : `Apply ${chosen.length} product${chosen.length === 1 ? '' : 's'}`}</button></>
        : <button className="btn primary" disabled={!!busy} onClick={onClose}>Done</button>}
    >
      {error && <div className="banner error">{error}</div>}
      {done !== null && <div className="banner info">Done: {done} products updated. Customers see the new text now.</div>}
      {!preview && (
        <>
          <p style={{ marginTop: 0 }}>Upload a sheet with an <b>SKU</b> column and a <b>Name</b> and/or <b>Description</b> column. You see every change before anything is saved; empty cells change nothing.</p>
          <div className="toolbar">
            {prepared && <button className="btn primary" disabled={!!busy} onClick={() => void usePrepared()}>Review the prepared write-ups</button>}
            <button className={`btn ${prepared ? '' : 'primary'}`} disabled={!!busy} onClick={() => input.current?.click()}>{busy || 'Choose spreadsheet'}</button>
          </div>
        </>
      )}
      <input ref={input} type="file" hidden accept=".xlsx,.csv" onChange={pick} />
      {preview && (
        <>
          <div className="toolbar">
            <Tabs value={show} onChange={setShow} options={[{ value: 'change', label: `Changes ${preview.summary.change}` }, { value: 'same', label: `No change ${preview.summary.same}` }, { value: 'missing', label: `SKU not found ${preview.summary.missing}` }, { value: 'all', label: `All ${preview.summary.rows}` }]} />
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
            <table>
              <thead><tr><th></th><th>SKU</th><th>Now</th><th>New</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td><input type="checkbox" aria-label={`Apply ${r.sku}`} disabled={r.action !== 'change'} checked={ticked.has(r.key)} onChange={() => toggle(r.key)} /></td>
                    <td className="mono small">{r.sku}</td>
                    <td style={{ maxWidth: 320 }}><b>{r.currentName ?? '—'}</b><div className="muted small">{r.currentDescription ?? ''}</div></td>
                    <td style={{ maxWidth: 360 }}><b>{r.name ?? (r.currentName ?? '')}</b><div className="small">{r.description ?? <span className="muted">(unchanged)</span>}</div></td>
                    <td><Pill tone={r.action === 'change' ? 'green' : r.action === 'missing' ? 'red' : undefined}>{r.action === 'change' ? 'Change' : r.action === 'missing' ? 'Not found' : 'No change'}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

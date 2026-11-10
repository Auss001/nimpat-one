import { ChangeEvent, useMemo, useRef, useState } from 'react';
import { post, upload } from '../api';
import { formatNaira } from '../money';
import { Modal, Pill, Tabs, useToast } from './ui';

type Action = 'update' | 'same' | 'new' | 'check' | 'skip';
interface Row {
  key: string;
  sheet: string;
  line: number;
  code: string;
  name: string;
  salePriceMinor: number | null;
  costPriceMinor: number | null;
  quantity: number | null;
  match: { variantId: string; sku: string; product: string; currentPriceMinor: number | null; how: string } | null;
  action: Action;
  warnings: string[];
}
interface Preview {
  division: { slug: string; name: string; isPharmacy: boolean };
  fileName: string;
  skippedSheets: string[];
  summary: Record<Action | 'rows', number>;
  rows: Row[];
}

const LABEL: Record<Action, string> = { update: 'Price change', same: 'No change', new: 'New product', check: 'Please check', skip: 'Skipped' };
const TONE: Record<Action, 'green' | 'blue' | 'amber' | 'red' | undefined> = { update: 'green', same: undefined, new: 'blue', check: 'amber', skip: 'red' };
/** Ticked to begin with: the sure changes. Rows to check wait for a person. */
const START_TICKED: Action[] = ['update', 'same', 'new'];

/** Upload a store's latest price list, see what would change, and apply the ticked rows. */
export function PriceListUpload({ division, title, onClose, onChanged }: { division: string; title: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<'all' | Action>('all');
  const [busy, setBusy] = useState<'' | 'reading' | 'applying'>('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ updated: number; created: number } | null>(null);

  const read = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('reading');
    setError(null);
    setDone(null);
    try {
      const p = await upload<Preview>('/admin/catalog/price-list/preview', file, { division });
      setPreview(p);
      setTicked(new Set(p.rows.filter((r) => START_TICKED.includes(r.action)).map((r) => r.key)));
      setShow(p.summary.check ? 'check' : 'all');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const rows = useMemo(() => (preview?.rows ?? []).filter((r) => show === 'all' || r.action === show), [preview, show]);
  const chosen = (preview?.rows ?? []).filter((r) => ticked.has(r.key));
  const counts = { updates: chosen.filter((r) => r.match).length, created: chosen.filter((r) => !r.match).length };
  const toggle = (key: string) => setTicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allOn = rows.length > 0 && rows.filter((r) => r.action !== 'skip').every((r) => ticked.has(r.key));
  const toggleAll = () => setTicked((s) => { const n = new Set(s); for (const r of rows) if (r.action !== 'skip') { if (allOn) n.delete(r.key); else n.add(r.key); } return n; });

  const apply = async () => {
    if (!preview || !chosen.length) return;
    setBusy('applying');
    setError(null);
    try {
      const r = await post<{ updated: number; created: number }>('/admin/catalog/price-list/apply', {
        division,
        fileName: preview.fileName,
        items: chosen.map((x) => ({ variantId: x.match?.variantId, name: x.name, salePriceMinor: x.salePriceMinor, quantity: x.quantity, code: x.code || null })),
      });
      setDone(r);
      setPreview(null);
      toast(`${r.updated} prices updated${r.created ? `, ${r.created} products added` : ''}`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const options = preview
    ? ([['all', `All ${preview.summary.rows}`], ['update', `Price changes ${preview.summary.update}`], ['new', `New ${preview.summary.new}`], ['check', `Please check ${preview.summary.check}`], ['same', `No change ${preview.summary.same}`], ['skip', `Skipped ${preview.summary.skip}`]] as const)
        .filter(([v, ]) => v === 'all' || preview.summary[v as Action] > 0)
        .map(([value, label]) => ({ value, label }))
    : [];

  return (
    <Modal
      title={`Upload a price list: ${title}`}
      onClose={() => { if (!busy) onClose(); }}
      wide
      footer={
        preview ? (
          <>
            <button className="btn" disabled={!!busy} onClick={() => { setPreview(null); input.current?.click(); }}>Choose another file</button>
            <button className="btn primary" disabled={!!busy || !chosen.length} onClick={() => void apply()}>
              {busy === 'applying' ? 'Applying…' : `Apply ${counts.updates} price${counts.updates === 1 ? '' : 's'}${counts.created ? ` and add ${counts.created} product${counts.created === 1 ? '' : 's'}` : ''}`}
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!!busy} onClick={onClose}>Done</button>
        )
      }
    >
      {error && <div className="banner error">{error}</div>}
      {done && <div className="banner info">Done: {done.updated} prices updated{done.created ? ` and ${done.created} products added` : ''}. Customers see the new prices now.</div>}

      {!preview && (
        <>
          <p style={{ marginTop: 0 }}>Upload the store's latest list as Excel (.xlsx) or CSV. Nothing changes until you check the preview and press Apply.</p>
          <ul className="muted small" style={{ marginTop: 0 }}>
            <li>The first row should have headings, such as <b>Description</b>, <b>Sales price</b>, and optionally <b>Barcode</b>/<b>Stock code</b>, <b>Cost price</b> and <b>Quantity</b>. Every sheet is read.</li>
            <li>Rows are matched by barcode or stock code first, then by name. Codes are remembered, so the next upload matches exactly.</li>
            <li>Cost prices are only used to spot mistakes. Customers never see them.</li>
            {division === 'pharmacy-laboratory' && <li>New medicines are added awaiting pharmacist approval, so none can be bought until the pharmacist approves it.</li>}
            {division !== 'pharmacy-laboratory' && <li>New products are added as drafts, for you to check and publish.</li>}
          </ul>
          <div className="toolbar">
            <button className="btn primary" disabled={!!busy} onClick={() => input.current?.click()}>{busy === 'reading' ? 'Reading…' : 'Choose spreadsheet'}</button>
          </div>
        </>
      )}
      <input ref={input} type="file" hidden accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void read(e)} />

      {preview && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {preview.fileName}: {preview.summary.rows} rows read.
            {preview.skippedSheets.length > 0 && ` Sheets without price headings were left out: ${preview.skippedSheets.join(', ')}.`}
            {' '}Rows marked “Please check” are not ticked; tick them once you are sure.
          </p>
          <div className="toolbar"><Tabs value={show} options={options as { value: 'all' | Action; label: string }[]} onChange={setShow} /></div>
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Tick all shown" checked={allOn} onChange={toggleAll} /></th>
                  <th>In the file</th>
                  <th>Product in the shop</th>
                  <th className="num">Now</th>
                  <th className="num">New</th>
                  <th className="num">Qty</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td><input type="checkbox" aria-label={`Apply ${r.name}`} disabled={r.action === 'skip'} checked={ticked.has(r.key)} onChange={() => toggle(r.key)} /></td>
                    <td>{r.name}<div className="muted small">{r.code ? `${r.code} · ` : ''}{r.sheet}, row {r.line}</div></td>
                    <td>{r.match ? <>{r.match.product}<div className="muted small">{r.match.sku}{r.match.how === 'possible' ? ' · possible match' : ''}</div></> : <span className="muted">Not in the shop yet</span>}</td>
                    <td className="num">{r.match ? (r.match.currentPriceMinor !== null ? formatNaira(r.match.currentPriceMinor) : '—') : ''}</td>
                    <td className="num"><b>{r.salePriceMinor !== null ? formatNaira(r.salePriceMinor) : '—'}</b></td>
                    <td className="num">{r.quantity ?? ''}</td>
                    <td><Pill tone={TONE[r.action]}>{ticked.has(r.key) && r.action === 'check' ? (r.match ? 'Update (checked)' : 'Add (checked)') : LABEL[r.action]}</Pill>{r.warnings.map((w) => <div key={w} className="muted small">{w}</div>)}</td>
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

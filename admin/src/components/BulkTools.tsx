import { useState } from 'react';
import { downloadFile, post } from '../api';
import { Modal, useToast } from './ui';

/** Tick boxes for a list: which rows are picked, and whether "everything matching" is picked. */
export function useSelection() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const toggle = (id: string) => { setAllMatching(false); setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const togglePage = (pageIds: string[]) => {
    setAllMatching(false);
    setIds((s) => { const on = pageIds.length > 0 && pageIds.every((i) => s.has(i)); const n = new Set(s); pageIds.forEach((i) => (on ? n.delete(i) : n.add(i))); return n; });
  };
  const clear = () => { setIds(new Set()); setAllMatching(false); };
  return { ids, allMatching, setAllMatching, toggle, togglePage, clear };
}
export type Selection = ReturnType<typeof useSelection>;

export function PageCheck({ sel, pageIds, label }: { sel: Selection; pageIds: string[]; label: string }) {
  const on = sel.allMatching || (pageIds.length > 0 && pageIds.every((i) => sel.ids.has(i)));
  return <input type="checkbox" className="row-check" aria-label={label} title="Select all on this page" checked={on} onChange={() => sel.togglePage(pageIds)} />;
}

export function RowCheck({ sel, id, label }: { sel: Selection; id: string; label: string }) {
  return <input type="checkbox" className="row-check" aria-label={label} checked={sel.allMatching || sel.ids.has(id)} onChange={() => sel.toggle(id)} />;
}

interface BulkResult { deleted: number; skipped: { reason: string; orderNumber?: string; id?: string }[] }

/**
 * The bar over a list: export to a spreadsheet, and delete what is picked (typed confirmation). Picking every row on
 * the page offers "select all N matching", so a whole filtered list (for example every pending order) can be handled at once.
 */
export function BulkBar({ sel, pageIds, total, noun, exportPath, exportName, deletePath, filter, deleteNote, canDelete, onDone }: {
  sel: Selection;
  pageIds: string[];
  total: number;
  noun: [string, string];
  exportPath: string;
  exportName: string;
  deletePath: string;
  filter: Record<string, string | undefined>;
  deleteNote: string;
  canDelete: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const count = sel.allMatching ? total : sel.ids.size;
  const word = (n: number) => `${n.toLocaleString('en-NG')} ${n === 1 ? noun[0] : noun[1]}`;
  const pageAllOn = pageIds.length > 0 && pageIds.every((i) => sel.ids.has(i));

  const doExport = async () => {
    try {
      const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
      await downloadFile(`${exportPath}${qs ? `?${qs}` : ''}`, exportName);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const doDelete = async () => {
    setBusy(true);
    try {
      const body = sel.allMatching ? { allMatching: true, filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) } : { ids: [...sel.ids] };
      const r = await post<BulkResult>(deletePath, body);
      setConfirming(false);
      setTyped('');
      sel.clear();
      setResult(r);
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="bulk-bar" role="region" aria-label={`Actions for ${noun[1]}`}>
        {count > 0 ? <strong>{word(count)} selected</strong> : <span className="muted small">Tick {noun[1]} to act on them, or export the whole list.</span>}
        {pageAllOn && !sel.allMatching && total > pageIds.length && <button className="btn sm link" onClick={() => sel.setAllMatching(true)}>Select all {word(total)} matching</button>}
        <button className="btn sm" onClick={() => void doExport()}>Export to spreadsheet ({word(total)})</button>
        {count > 0 && canDelete && <button className="btn sm danger" onClick={() => setConfirming(true)}>Delete {word(count)}</button>}
        {count > 0 && <button className="btn sm link" onClick={sel.clear}>Clear</button>}
      </div>
      {confirming && (
        <Modal
          title={`Delete ${word(count)}?`}
          onClose={() => setConfirming(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn danger" disabled={busy || typed.trim().toUpperCase() !== 'DELETE'} onClick={() => void doDelete()}>{busy ? 'Deleting…' : `Delete ${word(count)}`}</button>
          </>}
        >
          <p style={{ marginTop: 0 }}>{deleteNote}</p>
          <p>This cannot be undone. Type <strong>DELETE</strong> to confirm.</p>
          <input className="search" style={{ width: '100%' }} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type DELETE to confirm" />
        </Modal>
      )}
      {result && (
        <Modal title="Done" onClose={() => setResult(null)} footer={<button className="btn primary" onClick={() => setResult(null)}>OK</button>}>
          <p style={{ marginTop: 0 }}><strong>{word(result.deleted)} deleted.</strong></p>
          {result.skipped.length > 0 && (
            <>
              <p>{word(result.skipped.length)} kept:</p>
              <ul className="small">{result.skipped.slice(0, 30).map((s, i) => <li key={i}>{s.orderNumber ?? s.id}: {s.reason}</li>)}</ul>
              {result.skipped.length > 30 && <p className="muted small">and {result.skipped.length - 30} more.</p>}
            </>
          )}
        </Modal>
      )}
    </>
  );
}

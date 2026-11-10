import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { del, get, patch, upload } from '../api';
import { Loading, Modal, Pill, useConfirm, useLoad, useToast } from './ui';

export type PhotoOwner = 'product' | 'property' | 'unit' | 'vehicle' | 'spa' | 'service';
export interface PhotoTarget {
  owner: PhotoOwner;
  id: string;
}

interface Photo {
  id: string;
  url: string;
  variantId?: string | null;
  warning?: string;
}
interface Gallery {
  label: string;
  preset: 'product' | 'scene';
  single: boolean;
  photos: Photo[];
  variants: { id: string; name: string; sku: string }[];
}

const ACCEPT = 'image/jpeg,image/png,image/webp';

/** A dashed area to drop files on. Clicking it opens the file picker too. */
function DropZone({ onFiles, disabled, accept, label, hint }: { onFiles: (files: File[]) => void; disabled?: boolean; accept: string; label: string; hint?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const allowed = (f: File) => accept.split(',').some((a) => (a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a === f.type));
  return (
    <div
      className={`drop-zone ${over ? 'over' : ''} ${disabled ? 'off' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = [...e.dataTransfer.files].filter(allowed);
        if (files.length) onFiles(files);
      }}
    >
      <b>{label}</b>
      <span>{hint ?? 'or click to choose'}</span>
      <input ref={input} type="file" hidden multiple accept={accept} onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) onFiles(files); }} />
    </div>
  );
}

/** Upload, replace, remove and choose the main photo, for anything that shows photos. */
export function PhotoManager({ owner, id, onClose, onChanged }: PhotoTarget & { onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const gallery = useLoad(() => get<Gallery>(`/admin/photos/${owner}/${id}`), [owner, id]);
  const [busy, setBusy] = useState('');
  const { ask, dialog } = useConfirm();
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const g = gallery.data;
  const base = `/admin/photos/${owner}/${id}`;

  const refresh = async () => {
    await gallery.reload();
    onChanged?.();
  };

  const send = async (files: File[], replaceId?: string) => {
    let ok = 0;
    for (const [i, file] of files.entries()) {
      setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
      try {
        const r = await upload<Photo>(base, file, replaceId ? { replaceId } : {});
        ok++;
        if (r.warning) toast(`${file.name}: ${r.warning}`, 'error');
      } catch (e) {
        toast(`${file.name}: ${(e as Error).message}`, 'error');
      }
    }
    setBusy('');
    if (ok) {
      toast(ok === 1 ? (replaceId ? 'Photo replaced' : 'Photo added') : `${ok} photos added`);
      await refresh();
    }
  };

  const onAdd = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) void send(g?.single ? files.slice(0, 1) : files);
  };
  const onReplace = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && replacing.current) void send([file], replacing.current);
  };

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy('Saving…');
    try {
      await work();
      toast(done);
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title={g ? `Photos: ${g.label}` : 'Photos'} onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <Loading error={gallery.error} loading={gallery.loading && !g} />
      {g && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {g.preset === 'product'
              ? 'Each photo is resized to a matching white square, with plain margins removed. A clean photo on a white background works best.'
              : 'Each photo is cropped to the same landscape shape, keeping the most important part in view.'}
            {' '}JPG, PNG or WebP, up to 15 MB. What you see below is what customers will see.
          </p>
          {!g.photos.length && <div className="empty">No photo yet.</div>}
          <div className="photo-grid">
            {g.photos.map((p, i) => (
              <figure key={p.id} className={`photo-card ${g.preset}`}>
                <img src={p.url} alt={g.label} loading="lazy" />
                {i === 0 && !g.single && <span className="photo-main"><Pill tone="orange">Main photo</Pill></span>}
                <figcaption>
                  {g.variants.length > 1 && (
                    <select
                      aria-label="Size or pack shown"
                      value={p.variantId ?? ''}
                      disabled={!!busy}
                      onChange={(e) => void act(() => patch(`${base}/${p.id}`, { variantId: e.target.value || null }), 'Photo updated')}
                    >
                      <option value="">All sizes</option>
                      {g.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  )}
                  <div className="row-actions">
                    {i > 0 && <button className="btn sm" disabled={!!busy} onClick={() => void act(() => patch(`${base}/${p.id}`, { main: true }), 'Main photo changed')}>Make main</button>}
                    <button className="btn sm" disabled={!!busy} onClick={() => { replacing.current = p.id; replaceInput.current?.click(); }}>Replace</button>
                    <button className="btn sm danger" disabled={!!busy} onClick={() => ask('Remove this photo? This cannot be undone.', () => void act(() => del(`${base}/${p.id}`), 'Photo removed'), 'Remove photo')}>Remove</button>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
          {(!g.single || !g.photos.length) && (
            <DropZone
              accept={ACCEPT}
              disabled={!!busy}
              label={g.single ? 'Drag a photo here' : 'Drag photos here to add them'}
              hint={g.single ? 'or click to choose one' : 'several at once is fine, or click to choose'}
              onFiles={(files) => void send(g.single ? files.slice(0, 1) : files)}
            />
          )}
          {busy && <p className="muted small" role="status" style={{ marginBottom: 0 }}>{busy}</p>}
          <input ref={addInput} type="file" hidden accept={ACCEPT} multiple={!g.single} onChange={onAdd} />
          <input ref={replaceInput} type="file" hidden accept={ACCEPT} onChange={onReplace} />
        </>
      )}
      {dialog}
    </Modal>
  );
}

interface BulkRow {
  file: string;
  state: 'waiting' | 'done' | 'failed';
  message?: string;
  url?: string;
}

/** Uploads a whole folder of product photos. Each file name decides which product it belongs to. */
export function BulkPhotoUpload({ onClose, onChanged, cars = false }: { onClose: () => void; onChanged: () => void; cars?: boolean }) {
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [running, setRunning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = rows.filter((r) => r.state === 'done').length;
  const failed = rows.filter((r) => r.state === 'failed').length;

  // Photos prepared outside the dashboard (car stand chat, water bottles), shipped with it for a one-time upload.
  const [prepared, setPrepared] = useState<string[]>([]);
  useEffect(() => {
    fetch(`/prepared/${cars ? 'cars' : 'products'}/manifest.json`).then((r) => (r.ok ? r.json() : null)).then((m) => setPrepared(m?.files ?? [])).catch(() => setPrepared([]));
  }, [cars]);
  const startPrepared = async () => {
    setRunning(true);
    const files: File[] = [];
    for (const name of prepared) {
      const r = await fetch(`/prepared/${cars ? 'cars' : 'products'}/${name}`);
      if (r.ok) files.push(new File([await r.blob()], name, { type: name.endsWith('.csv') ? 'text/csv' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }));
    }
    await run(files);
  };

  const start = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    await run(files);
  };

  const run = async (files: File[]) => {
    if (!files.length) {
      setRunning(false);
      return;
    }
    setRows(files.map((f) => ({ file: f.name, state: 'waiting' })));
    setRunning(true);
    for (const [i, file] of files.entries()) {
      let next: Partial<BulkRow>;
      try {
        if (cars && /\.(csv|xlsx)$/i.test(file.name)) {
          // The car details sheet: trim, transmission, fuel, colour, description and features.
          const d = await upload<{ updated: number; notFound: string[] }>('/admin/vehicles/details-import', file);
          next = { state: d.notFound.length ? 'failed' : 'done', message: `Details filled in for ${d.updated} cars${d.notFound.length ? `. Not found: ${d.notFound.join(', ')}` : ''}` };
        } else {
          const r = await upload<{ product: string; action: string; url: string; warning?: string }>('/admin/photos/by-sku', file);
          next = { state: 'done', url: r.url, message: `${r.action === 'replaced' ? 'Replaced photos on' : 'Added to'} ${r.product}${r.warning ? `. ${r.warning}` : ''}` };
        }
      } catch (err) {
        next = { state: 'failed', message: (err as Error).message };
      }
      setRows((all) => all.map((row, j) => (j === i ? { ...row, ...next } : row)));
    }
    setRunning(false);
    onChanged();
  };

  return (
    <Modal
      title={cars ? 'Upload car photos and details' : 'Upload product photos in bulk'}
      onClose={() => { if (!running) onClose(); }}
      wide
      footer={<button className="btn primary" disabled={running} onClick={onClose}>Done</button>}
    >
      {cars ? (
        <>
          <p style={{ marginTop: 0 }}>Name each photo after the car's web address and its place in the gallery, then choose them all together, with the details sheet if you have one.</p>
          <ul className="muted small" style={{ marginTop: 0 }}>
            <li><span className="mono">toyota-camry-2013-r8-01.jpg</span> becomes that car's first photo and replaces its old ones.</li>
            <li><span className="mono">toyota-camry-2013-r8-02.jpg</span>, <span className="mono">-03</span>… are added after it.</li>
            <li><span className="mono">car-details.csv</span> (or .xlsx) fills in trim, transmission, fuel, colour, description and features.</li>
          </ul>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>Name each file after the product's SKU, then choose them all together.</p>
          <ul className="muted small" style={{ marginTop: 0 }}>
            <li><span className="mono">NMP-WTR-002.png</span> replaces that product's photo.</li>
            <li><span className="mono">NMP-WTR-002-2.png</span> adds a second photo to it.</li>
          </ul>
        </>
      )}
      <DropZone
        accept={cars ? `${ACCEPT},.csv,.xlsx` : ACCEPT}
        disabled={running}
        label={cars ? 'Drag the photos (and details sheet) here' : 'Drag the photos here'}
        hint="a whole folder's files at once is fine, or click to choose"
        onFiles={(files) => void run(files)}
      />
      <div className="toolbar" style={{ marginTop: 12 }}>
        {prepared.length > 0 && <button className="btn primary" disabled={running} onClick={() => void startPrepared()}>Upload the prepared {cars ? 'car' : 'product'} photos ({prepared.length} files)</button>}
        <button className={`btn ${prepared.length > 0 ? '' : 'primary'}`} disabled={running} onClick={() => input.current?.click()}>{cars ? 'Choose photos and sheet' : 'Choose photos'}</button>
        {rows.length > 0 && <span className="muted small" role="status">{done} done{failed ? `, ${failed} failed` : ''}, of {rows.length}</span>}
      </div>
      <input ref={input} type="file" hidden multiple accept={cars ? `${ACCEPT},.csv,.xlsx` : ACCEPT} onChange={(e) => void start(e)} />
      {rows.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
          <table>
            <thead><tr><th style={{ width: 52 }}></th><th>File</th><th>Result</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.file}>
                  <td>{r.url ? <img className="thumb" src={r.url} alt="" /> : <div className="thumb" />}</td>
                  <td className="mono small">{r.file}</td>
                  <td>
                    {r.state === 'waiting' && <span className="muted small">Waiting…</span>}
                    {r.state === 'done' && <><Pill tone="green">Done</Pill> <span className="small">{r.message}</span></>}
                    {r.state === 'failed' && <><Pill tone="red">Failed</Pill> <span className="small">{r.message}</span></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}


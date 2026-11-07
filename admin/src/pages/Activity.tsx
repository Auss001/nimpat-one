import { useState } from 'react';
import { get } from '../api';
import { Loading, PageHead, Tabs, useLoad } from '../components/ui';

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'product', label: 'Products' },
  { value: 'variant', label: 'Prices' },
  { value: 'payment', label: 'Payments' },
  { value: 'order', label: 'Orders' },
  { value: 'staff', label: 'Staff' },
  { value: 'auth.', label: 'Sign-ins' },
];
const readable = (s: string) => s.replace(/[._]/g, ' ');

/** The permanent record of who did what. It can be read, never edited. */
export function ActivityPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => get<{ data: any[]; meta: { totalPages: number } }>(`/admin/audit-logs?pageSize=50&page=${page}${action ? `&action=${encodeURIComponent(action)}` : ''}`), [action, page]);
  return (
    <>
      <PageHead title="Activity log" subtitle="Who did what, and when. This record cannot be edited." />
      <div className="toolbar"><Tabs value={action} onChange={(v) => { setAction(v); setPage(1); }} options={FILTERS} /></div>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {list.data.data.length === 0 && <tr><td colSpan={4} className="empty">Nothing recorded here yet.</td></tr>}
              {list.data.data.map((a) => (
                <tr key={a.id}>
                  <td className="small">{new Date(a.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="small">{a.actor?.email ?? (a.actorId ? a.actorId.slice(0, 8) : 'System')}</td>
                  <td><strong>{readable(a.action)}</strong></td>
                  <td className="small muted mono" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>{a.changes ? JSON.stringify(a.changes).slice(0, 180) : a.entityId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.meta.totalPages > 1 && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Newer</button>
          <span className="muted small">Page {page} of {list.data.meta.totalPages}</span>
          <button className="btn sm" disabled={page >= list.data.meta.totalPages} onClick={() => setPage((n) => n + 1)}>Older</button>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { get } from '../api';
import { Loading, PageHead, Pill, useLoad } from '../components/ui';

export function CustomersPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  const list = useLoad(() => get<{ data: any[]; meta: { total: number; totalPages: number } }>(`/admin/customers?pageSize=50&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, page]);
  return (
    <>
      <PageHead title="Customers" subtitle={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? 'person' : 'people'} with a Nimpat One account.` : undefined} />
      <div className="toolbar"><input className="search" placeholder="Search name, email or phone" value={text} onChange={(e) => setText(e.target.value)} /></div>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th className="num">Orders</th><th className="num">Stays</th><th>Joined</th></tr></thead>
            <tbody>
              {list.data.data.length === 0 && <tr><td colSpan={6} className="empty">No customers found.</td></tr>}
              {list.data.data.map((c) => (
                <tr key={c.id}>
                  <td><strong>{[c.customerProfile?.firstName, c.customerProfile?.lastName].filter(Boolean).join(' ') || '—'}</strong></td>
                  <td><a href={`mailto:${c.email}`}>{c.email}</a> {!c.emailVerifiedAt && <Pill tone="amber">Not confirmed</Pill>}</td>
                  <td>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</td>
                  <td className="num">{c._count.orders}</td>
                  <td className="num">{c._count.reservations}</td>
                  <td className="small">{new Date(c.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.meta.totalPages > 1 && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Previous</button>
          <span className="muted small">Page {page} of {list.data.meta.totalPages}</span>
          <button className="btn sm" disabled={page >= list.data.meta.totalPages} onClick={() => setPage((n) => n + 1)}>Next</button>
        </div>
      )}
    </>
  );
}

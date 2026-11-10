import { useEffect, useState } from 'react';
import { contactPhone, get } from '../api';
import { Loading, PageHead, Pill, Tabs, useLoad } from '../components/ui';

export function CustomersPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<'' | 'members' | 'guests'>('');
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  const list = useLoad(() => get<{ data: any[]; members: number; meta: { total: number; totalPages: number } }>(`/admin/customers?pageSize=50&page=${page}${kind ? `&kind=${kind}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, page, kind]);
  return (
    <>
      <PageHead title="Customers" subtitle={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? 'person' : 'people'} shown. ${list.data.members} Royalty ${list.data.members === 1 ? 'Member' : 'Members'}.` : undefined} />
      <div className="toolbar">
        <Tabs value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={[{ value: '', label: 'Everyone' }, { value: 'members', label: 'Royalty Members' }, { value: 'guests', label: 'Guests' }]} />
        <input className="search" placeholder="Search name, email or phone" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Royalty</th><th className="num">Orders</th><th className="num">Apartments</th><th>Joined</th></tr></thead>
            <tbody>
              {list.data.data.length === 0 && <tr><td colSpan={7} className="empty">No customers found.</td></tr>}
              {list.data.data.map((c) => (
                <tr key={c.id}>
                  <td><strong>{[c.customerProfile?.firstName, c.customerProfile?.lastName].filter(Boolean).join(' ') || '—'}</strong></td>
                  <td><a href={`mailto:${c.isGuest ? c.contactEmail : c.email}`}>{c.isGuest ? c.contactEmail : c.email}</a> {c.isGuest ? <Pill tone="blue">Guest</Pill> : !c.emailVerifiedAt && <Pill tone="amber">Not confirmed</Pill>}</td>
                  <td>{contactPhone(c) ? <a href={`tel:${contactPhone(c)}`}>{contactPhone(c)}</a> : '—'}</td>
                  <td>{c.isGuest ? <span className="muted small">Guest</span> : <><Pill tone="orange">Member</Pill> <span className="small">{Number(c.loyaltyAccount?.pointsBalance ?? 0).toLocaleString('en-NG')} pts</span>{c.loyaltyAccount?.lifetimeEarned ? <div className="muted small">{Number(c.loyaltyAccount.lifetimeEarned).toLocaleString('en-NG')} earned in all</div> : null}</>}</td>
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

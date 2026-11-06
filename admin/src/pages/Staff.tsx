import { useState } from 'react';
import { useAccess } from '../access';
import { del, get, patch, post } from '../api';
import { Field, Loading, Modal, PageHead, StatusPill, useAction, useConfirm, useLoad, useToast } from '../components/ui';

interface Grant {
  id: string;
  divisionId: string | null;
  role: { code: string; name: string };
  division: { id: string; name: string; slug: string } | null;
}
interface StaffMember {
  id: string;
  email: string;
  status: string;
  lastLoginAt: string | null;
  staffProfile: { firstName: string; lastName: string; employeeNumber: string; jobTitle: string | null } | null;
  roles: Grant[];
}
interface RoleDef {
  code: string;
  name: string;
  description: string;
  isDivisionScoped: boolean;
}

const shortDivision = (name: string) => name.replace(/^Nimpat /, '');

/** Roles this person may hand out; the API enforces the same rule. */
function useGrantable() {
  const { me, divisionsFor } = useAccess();
  const roles = useLoad(() => get<RoleDef[]>('/admin/roles'));
  const isSuper = !!me?.roles.some((r) => r.code === 'SUPER_ADMIN');
  const usable = (roles.data ?? []).filter((r) => r.code !== 'CUSTOMER' && (isSuper || r.code === 'DEPARTMENT_STAFF'));
  // Most useful first, because managers are the usual reason to open this page.
  const order = ['DEPARTMENT_MANAGER', 'DEPARTMENT_STAFF', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT', 'GROUP_MANAGEMENT', 'SUPER_ADMIN'];
  return { roles: [...usable].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code)), divisions: divisionsFor('roles:assign') };
}

export function StaffPage() {
  const { me, can } = useAccess();
  const staff = useLoad(() => get<{ data: StaffMember[] }>('/admin/users?type=STAFF&pageSize=100'));
  const [adding, setAdding] = useState(false);
  const [granting, setGranting] = useState<StaffMember | null>(null);
  const [invite, setInvite] = useState<{ name: string; link: string | null } | null>(null);
  const { run } = useAction();
  const { ask, dialog } = useConfirm();
  const canSuspend = can({ any: ['staff:manage'] });

  const fullName = (s: StaffMember) => (s.staffProfile ? `${s.staffProfile.firstName} ${s.staffProfile.lastName}` : s.email);

  const removeRole = (s: StaffMember, g: Grant) =>
    ask(`Remove ${g.role.name}${g.division ? ` for ${shortDivision(g.division.name)}` : ''} from ${fullName(s)}? The change applies within seconds.`, () =>
      void run(async () => {
        await del(`/admin/users/${s.id}/roles/${g.id}`);
        await staff.reload();
      }, 'Access removed'), 'Remove access');

  const setStatus = (s: StaffMember, status: 'ACTIVE' | 'SUSPENDED') =>
    ask(status === 'SUSPENDED' ? `Suspend ${fullName(s)}? They will be signed out straight away and cannot sign in.` : `Reactivate ${fullName(s)}?`, () =>
      void run(async () => {
        await patch(`/admin/users/${s.id}/status`, { status });
        await staff.reload();
      }, status === 'SUSPENDED' ? 'Account suspended' : 'Account reactivated'), status === 'SUSPENDED' ? 'Suspend' : 'Reactivate');

  const newInvite = (s: StaffMember) =>
    void run(async () => {
      const r = await post<{ inviteLink: string | null }>(`/admin/users/${s.id}/invite`);
      setInvite({ name: fullName(s), link: r.inviteLink });
    });

  return (
    <>
      <PageHead
        title="Staff and managers"
        subtitle="Give people access to the backend. A Department Manager can edit prices, products, stock and bookings in their own division only."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>+ Add person</button>}
      />
      <Loading error={staff.error} loading={staff.loading && !staff.data} />
      {staff.data && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Access</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>
              {staff.data.data.length === 0 && <tr><td colSpan={5} className="empty">No staff yet.</td></tr>}
              {staff.data.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{fullName(s)}</strong>
                    <div className="muted small">{s.email}</div>
                    {s.staffProfile && <div className="muted small">{[s.staffProfile.jobTitle, s.staffProfile.employeeNumber].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td>
                    <div className="role-chips">
                      {s.roles.map((g) => (
                        <span className="role-chip" key={g.id}>
                          {g.role.name}{g.division ? `: ${shortDivision(g.division.name)}` : ''}
                          {s.id !== me?.id && <button aria-label={`Remove ${g.role.name}`} title="Remove this access" onClick={() => removeRole(s, g)}>×</button>}
                        </span>
                      ))}
                      {s.roles.length === 0 && <span className="muted small">No access</span>}
                    </div>
                  </td>
                  <td><StatusPill status={s.status} /></td>
                  <td className="small">{s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : <span className="muted">Never, invitation pending</span>}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn sm" onClick={() => setGranting(s)}>+ Access</button>
                      {!s.lastLoginAt && <button className="btn sm" onClick={() => newInvite(s)}>New invitation</button>}
                      {canSuspend && s.id !== me?.id && (s.status === 'ACTIVE'
                        ? <button className="btn sm danger" onClick={() => setStatus(s, 'SUSPENDED')}>Suspend</button>
                        : <button className="btn sm" onClick={() => setStatus(s, 'ACTIVE')}>Reactivate</button>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddForm
          onClose={() => setAdding(false)}
          onSaved={(name, link) => { setAdding(false); setInvite({ name, link }); void staff.reload(); }}
        />
      )}
      {granting && <GrantForm person={granting} name={fullName(granting)} onClose={() => setGranting(null)} onSaved={() => { setGranting(null); void staff.reload(); }} />}
      {invite && <InviteDialog {...invite} onClose={() => setInvite(null)} />}
      {dialog}
    </>
  );
}

function RoleFields({ role, division, setRole, setDivision }: { role: string; division: string; setRole: (v: string) => void; setDivision: (v: string) => void }) {
  const { roles, divisions } = useGrantable();
  const def = roles.find((r) => r.code === role);
  return (
    <>
      <Field label="Access level" hint={def?.description} full>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Choose…</option>
          {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
      </Field>
      {def?.isDivisionScoped && (
        <Field label="Division" hint="Add access again to cover more than one division" full>
          <select value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="">Choose…</option>
            {divisions.map((d) => <option key={d.id} value={d.id}>{shortDivision(d.name)}</option>)}
          </select>
        </Field>
      )}
      {role === 'SUPER_ADMIN' && <div className="banner warn field full" style={{ margin: 0 }}>A Super Administrator has full control of the system, including payments and staff.</div>}
    </>
  );
}

function useRoleChoice() {
  const { roles } = useGrantable();
  const [role, setRole] = useState('');
  const [division, setDivision] = useState('');
  const scoped = roles.find((r) => r.code === role)?.isDivisionScoped;
  return { role, setRole: (v: string) => { setRole(v); setDivision(''); }, division, setDivision, ready: !!role && (!scoped || !!division), divisionId: scoped ? division : undefined };
}

function AddForm({ onClose, onSaved }: { onClose: () => void; onSaved: (name: string, link: string | null) => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', employeeNumber: '', jobTitle: '' });
  const choice = useRoleChoice();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = f.firstName.trim() && f.lastName.trim() && /^\S+@\S+\.\S+$/.test(f.email.trim()) && f.employeeNumber.trim().length >= 2 && choice.ready;
  const save = () => {
    let link: string | null = null;
    return run(async () => {
      const r = await post<{ inviteLink: string | null }>('/admin/staff', {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), employeeNumber: f.employeeNumber.trim(),
        jobTitle: f.jobTitle.trim() || undefined, role: choice.role, divisionId: choice.divisionId,
      });
      link = r.inviteLink;
    }).then((ok) => ok && onSaved(`${f.firstName.trim()} ${f.lastName.trim()}`, link));
  };
  return (
    <Modal title="Add a person" onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>Create and invite</button></>}>
      <div className="form-grid">
        <Field label="First name"><input value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input value={f.lastName} onChange={set('lastName')} /></Field>
        <Field label="Email" hint="They sign in with this"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Employee number" hint="Must be unique"><input value={f.employeeNumber} onChange={set('employeeNumber')} placeholder="NIM-00123" /></Field>
        <Field label="Job title (optional)" full><input value={f.jobTitle} onChange={set('jobTitle')} /></Field>
        <RoleFields role={choice.role} division={choice.division} setRole={choice.setRole} setDivision={choice.setDivision} />
      </div>
    </Modal>
  );
}

function GrantForm({ person, name, onClose, onSaved }: { person: StaffMember; name: string; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const choice = useRoleChoice();
  const save = () => run(() => post(`/admin/users/${person.id}/roles`, { role: choice.role, divisionId: choice.divisionId }), 'Access added').then((ok) => ok && onSaved());
  return (
    <Modal title={`Add access for ${name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!choice.ready || busy} onClick={() => void save()}>Add access</button></>}>
      <div className="form-grid">
        <RoleFields role={choice.role} division={choice.division} setRole={choice.setRole} setDivision={choice.setDivision} />
      </div>
    </Modal>
  );
}

function InviteDialog({ name, link, onClose }: { name: string; link: string | null; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link ?? '');
      toast('Link copied');
    } catch {
      toast('Could not copy. Select the link and copy it by hand.', 'error');
    }
  };
  return (
    <Modal title={`Invitation for ${name}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      {link ? (
        <>
          <div className="banner warn">Email is not connected yet, so nothing was sent. Share this link with {name} privately.</div>
          <div className="copy-row">
            <input readOnly aria-label="Invitation link" value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => void copy()}>Copy</button>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>They use it once to choose a password. It expires in 72 hours, and anyone who has it can set up this account.</p>
        </>
      ) : (
        <p style={{ margin: 0 }}>An invitation has been emailed to {name}. It expires in 72 hours.</p>
      )}
    </Modal>
  );
}

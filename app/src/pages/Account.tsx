import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Award, CalendarCheck, Check, ChevronRight, Crown, Gift, Heart, LogOut, MailCheck, MapPin, Pencil, RotateCcw, Smartphone, Trash2, Truck } from 'lucide-react';
import { del, endSession, formatNaira, get, getSession, login, logout, patch, post, register, rows, startGuest, upgradeGuest } from '../api';
import { CallLink, dateTime, Empty, Field, Loader, Note, PageTitle, PasswordInput, Sheet, shortDate, Status, useCart, useLoad, useSession, useToast } from '../ui';
import { HelpLinks } from './Help';

/** Only a path inside the app may be a return address after sign-in. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function NeedsSignIn({ title, text, next }: { title: string; text: string; next: string }) {
  return (
    <>
      <PageTitle title={title} back={false} />
      <Empty title={text} action={<Link className="btn primary" to="/">Start shopping</Link>} />
      <p className="auth-switch">Have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link> · <Link to={`/register?next=${encodeURIComponent(next)}`}>Create one</Link></p>
    </>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <PageTitle title="Welcome back" sub="Sign in to your Nimpat One account." />
      <form className="panel" onSubmit={submit}>
        {error && <Note tone="error">{error}</Note>}
        <Field label="Email"><input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><PasswordInput required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <Link className="text-link" to="/forgot-password">Forgot your password?</Link>
      </form>
      <p className="auth-switch">New here? <Link to={`/register?next=${encodeURIComponent(safeNext(params.get('next')))}`}>Create an account</Link></p>
    </div>
  );
}

/** Name, email and phone, asked once when someone first orders or books. No account or password. */
export function DetailsForm({ onDone, title = 'Your details' }: { onDone: () => void; title?: string }) {
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await startGuest({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>{title}</h2>
      <p className="muted-text">For your receipt and so we can reach you about your order.</p>
      {error && <Note tone="error">{error}</Note>}
      <div className="date-pair">
        <Field label="First name"><input required autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input required autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></Field>
      </div>
      <Field label="Email" hint="For your receipt and order updates."><input type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Phone" hint="For delivery. e.g. 0803 123 4567, or +44… if abroad"><input type="tel" required autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
      <button className="btn primary full" disabled={busy}>{busy ? 'Starting…' : 'Continue'}</button>
    </form>
  );
}

/** Someone who ordered with just their details can add a password and keep their orders. */
function GuestUpgrade({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await upgradeGuest(password);
      toast('Welcome, Royalty Member! We have emailed you a code to confirm your address.');
      setOpen(false);
      onDone();
      navigate('/verify-email');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="reward guest-card">
        <Crown size={26} aria-hidden="true" />
        <div className="guest-card-body">
          <b>Become a Royalty Member</b>
          <small>Earn points on what you pay for, and see your orders on any device.</small>
        </div>
        <button className="btn gold" onClick={() => setOpen(true)}>Join now</button>
      </div>
      {open && (
        <Sheet title="Become a Royalty Member" onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="stack">
            <p className="muted-text">Choose a password. Your name, email and phone are already saved.</p>
            {error && <Note tone="error">{error}</Note>}
            <Field label="Password" hint="At least 10 characters, with a letter and a number."><PasswordInput required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="Type it again"><PasswordInput required minLength={10} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
            <button className="btn primary full" disabled={busy}>{busy ? 'Joining…' : 'Join now'}</button>
          </form>
        </Sheet>
      )}
    </>
  );
}

/** The Account tab before signing in: shopping needs no account; membership and signing in are options. */
function AccountOptions() {
  return (
    <>
      <PageTitle title="Account" back={false} />
      <div className="row">
        <Link className="btn primary grow" to="/login?next=/account">Sign in</Link>
        <Link className="btn ghost grow" to="/register?next=/account">Create account</Link>
      </div>
      <nav className="panel link-list" aria-label="Membership and orders">
        <Link to="/royalty"><Crown size={19} aria-hidden="true" /> Royalty Member <ChevronRight size={18} aria-hidden="true" /></Link>
        <Link to="/bookings"><CalendarCheck size={19} aria-hidden="true" /> Orders and bookings <ChevronRight size={18} aria-hidden="true" /></Link>
      </nav>
      <HelpLinks />
    </>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', again: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), password: f.password, ...(f.phone.trim() ? { phone: f.phone.trim() } : {}) });
      navigate(`/verify-email?next=${encodeURIComponent(safeNext(params.get('next')))}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <PageTitle title="Become a Royalty Member" sub="One account for everything Nimpat." />
      <form className="panel" onSubmit={submit}>
        {error && <Note tone="error">{error}</Note>}
        <div className="date-pair">
          <Field label="First name"><input required autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></Field>
          <Field label="Last name"><input required autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></Field>
        </div>
        <Field label="Email" hint="We will email you a 6-digit code to confirm it."><input type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone (optional)" hint="E.g. 0803 123 4567, or +44… if abroad"><input type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Password" hint="At least 10 characters, with a letter and a number."><PasswordInput required minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
        <Field label="Type your password again"><PasswordInput required minLength={10} autoComplete="new-password" value={f.again} onChange={set('again')} /></Field>
        <p className="legal-note">By creating an account, you agree to our <a href="/terms" target="_blank" rel="noreferrer">Terms of Use</a> and confirm you have read our <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>
        <button className="btn primary full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <p className="auth-switch">Already have an account? <Link to={`/login?next=${encodeURIComponent(safeNext(params.get('next')))}`}>Sign in</Link></p>
    </div>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <PageTitle title="Forgot your password?" />
      {sent ? <Note tone="ok">If that email has an account, a reset link is on its way. Please check your inbox.</Note> : (
        <form className="panel" onSubmit={submit}>
          {error && <Note tone="error">{error}</Note>}
          <Field label="Email"><input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn primary full" disabled={busy}>Send reset link</button>
        </form>
      )}
    </div>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reset-password', { token: params.get('token') ?? '', newPassword: password });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <PageTitle title="Choose a new password" back={false} />
      {done ? <><Note tone="ok">Your password has been changed.</Note><Link className="btn primary full" to="/login">Sign in</Link></> : (
        <form className="panel" onSubmit={submit}>
          {error && <Note tone="error">{error}</Note>}
          <Field label="New password" hint="At least 10 characters, with a letter and a number."><PasswordInput required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <button className="btn primary full" disabled={busy}>Save password</button>
        </form>
      )}
    </div>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  if (!token) return <VerifyCode next={safeNext(params.get('next'))} />;
  return <VerifyLink token={token} />;
}

/** Straight after joining: type the 6-digit code from the email. */
function VerifyCode({ next }: { next: string }) {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return <Navigate to="/login?next=/verify-email" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/verify-email-code', { code });
      toast('Your email is confirmed. Welcome!');
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    try {
      await post('/auth/resend-verification', { email: session.email });
      setCode('');
      setError(null);
      toast('A new code is on its way.');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="auth">
      <PageTitle title="Check your email" sub={`We sent a 6-digit code to ${session.email}.`} back={false} />
      <form className="panel" onSubmit={submit}>
        {error && <Note tone="error">{error}</Note>}
        <Field label="Code">
          <input className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
            value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} placeholder="••••••" />
        </Field>
        <button className="btn primary full" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Confirm email'}</button>
        <div className="row spread">
          <button type="button" className="text-link" onClick={() => void resend()}>Send a new code</button>
          <Link className="text-link" to={next}>Skip for now</Link>
        </div>
      </form>
      <p className="auth-switch">Can't find it? Check your spam folder. The code lasts 30 minutes.</p>
    </div>
  );
}

function VerifyLink({ token }: { token: string }) {
  const result = useLoad(() => post('/auth/verify-email', { token }), [token]);
  return (
    <div className="auth">
      <PageTitle title="Confirm your email" back={false} />
      {result.loading && <Loader />}
      {!result.loading && !result.error && <Note tone="ok">Your email is confirmed. Thank you.</Note>}
      {result.error && <Note tone="error">{result.error}</Note>}
      {!result.loading && <Link className="btn primary full" to="/">Go home</Link>}
    </div>
  );
}

export function VerifyEmailNote() {
  const session = getSession();
  const toast = useToast();
  const resend = async () => {
    try {
      await post('/auth/resend-verification', { email: session?.email });
      toast('Code sent. Please check your inbox.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return <Note tone="warn"><MailCheck size={16} aria-hidden="true" /> Please confirm your email before you pay. <Link className="text-link" to="/verify-email" onClick={() => void resend()}>Get a code</Link></Note>;
}

export const addressLine = (a: any) => [a.line1, a.line2, a.landmark, a.city, a.state].filter(Boolean).join(', ');

const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];

export function AddressForm({ address, onSaved, onCancel }: { address?: any; onSaved: (a: any) => void | Promise<void>; onCancel?: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    recipientName: address?.recipientName ?? '', phone: address?.phone ?? '', line1: address?.line1 ?? '', landmark: address?.landmark ?? '',
    city: address?.city ?? '', state: address?.state ?? 'FCT', label: address?.label ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      await onSaved(address ? await patch(`/me/addresses/${address.id}`, body) : await post('/me/addresses', body));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="address-form">
      <Field label="Who receives it?"><input autoComplete="name" value={f.recipientName} onChange={set('recipientName')} /></Field>
      <Field label="Their phone" hint="E.g. 0803 123 4567, or +44… if abroad"><input type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
      <Field label="Address"><input autoComplete="street-address" value={f.line1} onChange={set('line1')} /></Field>
      <Field label="Landmark (optional)"><input value={f.landmark} onChange={set('landmark')} /></Field>
      <div className="date-pair">
        <Field label="City or area"><input autoComplete="address-level2" value={f.city} onChange={set('city')} /></Field>
        <Field label="State"><select value={f.state} onChange={set('state')}>{STATES.map((s) => <option key={s}>{s}</option>)}</select></Field>
      </div>
      <Field label="Name this address (optional)" hint="Home, Office…"><input value={f.label} onChange={set('label')} /></Field>
      <div className="row">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn primary grow" disabled={busy || !f.recipientName.trim() || !f.phone.trim() || !f.line1.trim() || !f.city.trim()} onClick={submit}>{busy ? 'Saving…' : 'Save address'}</button>
      </div>
    </div>
  );
}

export function AccountPage() {
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useCart();
  const me = useLoad(() => (session ? get('/auth/me') : Promise.resolve(null)), [session?.email]);
  const addresses = useLoad(() => (session ? get('/me/addresses').then(rows) : Promise.resolve([])), [session?.email]);
  const [form, setForm] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
  const [profile, setProfile] = useState<{ firstName: string; lastName: string } | null>(null);
  if (!session) return <AccountOptions />;
  const m = me.data;
  const removeAddress = async (a: any) => {
    if (!window.confirm(`Remove ${a.label ?? a.line1}?`)) return;
    try {
      await del(`/me/addresses/${a.id}`);
      await addresses.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const saveProfile = async () => {
    try {
      await patch('/me/profile', profile);
      setProfile(null);
      await me.reload();
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <PageTitle title={m?.customerProfile?.firstName ? `Hello, ${m.customerProfile.firstName}` : 'Account'} sub={session.email} back={false} />
      {m && !m.emailVerified && !m.isGuest && <VerifyEmailNote />}
      {m?.isGuest && <GuestUpgrade onDone={() => void me.reload()} />}
      {m?.loyalty && !m.isGuest && (
        <Link to="/royalty" className="reward">
          <Award size={26} aria-hidden="true" />
          <div><b>Royalty Member</b><small>{Number(m.loyalty.pointsBalance).toLocaleString('en-NG')} points</small></div>
        </Link>
      )}
      <nav className="panel link-list" aria-label="Your account">
        <Link to="/bookings"><CalendarCheck size={19} aria-hidden="true" /> Orders and bookings <ChevronRight size={18} aria-hidden="true" /></Link>
        <Link to="/favorites"><Heart size={19} aria-hidden="true" /> Favourites <ChevronRight size={18} aria-hidden="true" /></Link>
      </nav>
      <HelpLinks />
      <section className="panel">
        <div className="panel-head"><h2>Your details</h2>{!profile && <button className="icon-btn" aria-label="Edit your details" onClick={() => setProfile({ firstName: m?.customerProfile?.firstName ?? '', lastName: m?.customerProfile?.lastName ?? '' })}><Pencil size={16} /></button>}</div>
        {profile ? (
          <>
            <div className="date-pair">
              <Field label="First name"><input value={profile.firstName} onChange={(e) => setProfile({ ...profile, firstName: e.target.value })} /></Field>
              <Field label="Last name"><input value={profile.lastName} onChange={(e) => setProfile({ ...profile, lastName: e.target.value })} /></Field>
            </div>
            <div className="row"><button className="btn ghost" onClick={() => setProfile(null)}>Cancel</button><button className="btn primary grow" onClick={saveProfile}>Save</button></div>
          </>
        ) : (
          <p>{[m?.customerProfile?.firstName, m?.customerProfile?.lastName].filter(Boolean).join(' ') || session.email}</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Addresses</h2><button className="text-link" onClick={() => setForm({})}>Add</button></div>
        {addresses.data?.length === 0 && !form && <p className="muted-text">No addresses yet.</p>}
        {addresses.data?.map((a: any) => (
          <div key={a.id} className="address-row">
            <MapPin size={18} aria-hidden="true" />
            <span><b>{a.label ?? a.recipientName}</b><small>{addressLine(a)}</small></span>
            <button className="icon-btn" aria-label={`Edit ${a.label ?? a.line1}`} onClick={() => setForm(a)}><Pencil size={16} /></button>
            <button className="icon-btn" aria-label={`Remove ${a.label ?? a.line1}`} onClick={() => removeAddress(a)}><Trash2 size={16} /></button>
          </div>
        ))}
        {form && <AddressForm key={form.id ?? 'new'} address={form.id ? form : undefined} onCancel={() => setForm(null)} onSaved={async () => { setForm(null); await addresses.reload(); }} />}
      </section>
      <section className="panel">
        <h2>Help</h2>
        <CallLink />
      </section>
      {m?.isGuest && <p className="muted-text">Add a password above before signing out, so you can come back to these orders.</p>}
      <button className="btn ghost full" onClick={async () => { await logout(); await refresh(); navigate('/'); }}><LogOut size={16} aria-hidden="true" /> Sign out</button>
      <button className="text-link danger" onClick={() => setDeleting(true)}>Delete my account</button>
      {deleting && <DeleteAccount guest={!!m?.isGuest} onClose={() => setDeleting(false)} />}
    </>
  );
}

function DeleteAccount({ onClose, guest }: { onClose: () => void; guest: boolean }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useCart();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await del('/me', guest ? {} : { password });
      endSession();
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet title="Delete your account?" onClose={onClose}>
      <p>This signs you out everywhere and removes your name, email, phone and addresses. Past order and payment records stay, without those details. This cannot be undone. Any open order or booking must be finished or cancelled first.</p>
      {error && <Note tone="error">{error}</Note>}
      {!guest && <Field label="Enter your password to confirm"><PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Keep my account</button>
        <button className="btn danger grow" disabled={busy || (!guest && !password)} onClick={submit}>{busy ? 'Deleting…' : 'Delete my account'}</button>
      </div>
    </Sheet>
  );
}

const INQUIRY_LABEL: Record<string, string> = { GENERAL: 'Question', TEST_DRIVE: 'Test drive', INSPECTION: 'Inspection', DEPOSIT_HOLD: 'Deposit hold', FINANCING: 'Financing' };

const TABS = [
  { key: 'orders', label: 'Orders' },
  { key: 'stays', label: 'Luxury Apartments' },
  { key: 'spa', label: 'Spa' },
  { key: 'services', label: 'Services' },
  { key: 'cars', label: 'Cars' },
] as const;

export function BookingsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'orders') as (typeof TABS)[number]['key'];
  if (!session) return <NeedsSignIn title="Orders & bookings" text="Nothing ordered yet" next="/bookings" />;
  return (
    <>
      <PageTitle title="Orders & bookings" back={false} />
      <div className="chips" role="tablist">
        {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setParams({ tab: t.key }, { replace: true })}>{t.label}</button>)}
      </div>
      {tab === 'orders' && <History path="/orders" cancel={(o) => `/orders/${o.id}/cancel`} canCancel={(o) => ['PENDING', 'ACCEPTED'].includes(o.status)} purpose="ORDER" empty="No orders yet." render={(o) => ({
        title: o.orderNumber, sub: `${o.items?.length ?? 0} ${o.items?.length === 1 ? 'item' : 'items'}${o.division?.name ? ` · ${o.division.name}` : ''} · ${shortDate(o.createdAt)}`, amount: o.totalMinor, owing: o.outstandingMinor, details: o.items?.map((i: any) => `${i.quantity} × ${i.productName}`).join(', '),
      })} />}
      {tab === 'stays' && <History path="/apartments/reservations" cancel={(r) => `/apartments/reservations/${r.id}/cancel`} canCancel={(r) => ['HOLD', 'CONFIRMED'].includes(r.status)} purpose="APARTMENT_RESERVATION" empty="No apartment bookings yet." render={(r) => ({
        title: r.unit?.property?.name ?? r.reservationNumber, sub: `${r.room?.name ?? r.unit?.name} · ${shortDate(r.checkIn)} to ${shortDate(r.checkOut)}`, amount: r.totalMinor, owing: Number(r.totalMinor) - Number(r.amountPaidMinor), details: r.status === 'HOLD' && r.holdExpiresAt ? `Held until ${dateTime(r.holdExpiresAt)}` : r.reservationNumber,
      })} />}
      {tab === 'spa' && <History path="/spa/appointments" cancel={(a) => `/spa/appointments/${a.id}/cancel`} canCancel={(a) => ['REQUESTED', 'PENDING', 'CONFIRMED'].includes(a.status)} purpose="SPA_APPOINTMENT" empty="No spa appointments yet." render={(a) => ({
        title: a.treatment?.name ?? a.appointmentNumber, sub: dateTime(a.startsAt), amount: a.priceMinor, owing: Number(a.priceMinor) - Number(a.amountPaidMinor), details: a.practitioner?.displayName,
      })} />}
      {tab === 'services' && <History path="/services/bookings" cancel={(b) => `/services/bookings/${b.id}/cancel`} canCancel={(b) => ['REQUESTED', 'PENDING', 'CONFIRMED'].includes(b.status)} purpose="SERVICE_BOOKING" empty="No service bookings yet." render={(b) => ({
        title: b.offering?.name ?? b.bookingNumber, sub: b.scheduledStart ? dateTime(b.scheduledStart) : 'We will confirm the time', amount: b.priceMinor, owing: b.priceMinor === null ? 0 : Number(b.priceMinor) - Number(b.amountPaidMinor), details: b.bookingNumber, payable: b.status === 'PENDING' || b.status === 'CONFIRMED',
      })} />}
      {tab === 'cars' && <History path="/vehicles/inquiries/mine" empty="No car enquiries yet." render={(i) => ({
        title: i.vehicle ? `${i.vehicle.year} ${i.vehicle.make} ${i.vehicle.model}` : 'Car enquiry', sub: `${INQUIRY_LABEL[i.type] ?? 'Enquiry'} · ${shortDate(i.createdAt)}`,
      })} />}
    </>
  );
}

interface Rendered {
  title: string;
  sub: string;
  amount?: number | null;
  owing?: number;
  details?: string;
  payable?: boolean;
}

const ORDER_STEPS: [string, string[]][] = [
  ['Placed', ['PENDING']],
  ['Accepted', ['ACCEPTED']],
  ['Preparing', ['PROCESSING', 'READY']],
  ['On the way', ['OUT_FOR_DELIVERY']],
  ['Delivered', ['DELIVERED', 'COMPLETED']],
];

function OrderSteps({ status }: { status: string }) {
  const at = ORDER_STEPS.findIndex(([, statuses]) => statuses.includes(status));
  if (at < 0) return null;
  return (
    <ol className="order-steps" aria-label={`Order progress: ${ORDER_STEPS[at][0]}`}>
      {ORDER_STEPS.map(([label], n) => <li key={label} className={n <= at ? 'done' : ''}><span>{label}</span></li>)}
    </ol>
  );
}

function OrderAgain({ order }: { order: any }) {
  const { refresh } = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    const results = await Promise.allSettled((order.items ?? []).map((i: any) => post('/carts/items', { variantId: i.variantId, quantity: i.quantity })));
    await refresh();
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast(`${failed} ${failed === 1 ? 'item is' : 'items are'} no longer available`, 'error');
    setBusy(false);
    if (failed < results.length) navigate('/cart');
  };
  return <button className="btn ghost" disabled={busy} onClick={again}><RotateCcw size={15} aria-hidden="true" /> Order again</button>;
}

function History({ path, cancel, canCancel, purpose, empty, render }: { path: string; cancel?: (row: any) => string; canCancel?: (row: any) => boolean; purpose?: string; empty: string; render: (row: any) => Rendered }) {
  const list = useLoad(() => get(path).then(rows), [path]);
  const toast = useToast();
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState<any>(null);
  const [reason, setReason] = useState('');
  useEffect(() => setCancelling(null), [path]);
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <Note tone="error">{list.error}</Note>;
  if (!list.data?.length) return <Empty title={empty} action={<Link className="btn primary" to="/">Explore Nimpat One</Link>} />;
  const doCancel = async () => {
    try {
      await post(cancel!(cancelling), reason.trim() ? { reason: reason.trim() } : {});
      toast('Cancelled');
      setCancelling(null);
      setReason('');
      await list.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="list">
      {list.data.map((row: any) => {
        const r = render(row);
        const closed = ['CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW'].includes(row.status);
        const payable = purpose && !closed && (r.owing ?? 0) > 0 && r.payable !== false && row.paymentStatus !== 'AWAITING_VERIFICATION';
        return (
          <article key={row.id} className="history">
            <div className="history-head">{path === '/orders' ? <Link to={`/orders/${row.id}`}><b>{r.title}</b></Link> : <b>{r.title}</b>}<Status value={row.status} /></div>
            <small>{r.sub}</small>
            {r.details && <small>{r.details}</small>}
            {path === '/orders' && <OrderSteps status={row.status} />}
            <div className="history-foot">
              {r.amount !== null && r.amount !== undefined ? <span className="price">{formatNaira(r.amount)}</span> : <span />}
              {purpose && r.amount !== null && r.amount !== undefined && row.paymentStatus && <Status value={row.paymentStatus} />}
            </div>
            {(payable || (canCancel?.(row) && cancel)) && (
              <div className="row">
                {canCancel?.(row) && cancel && <button className="btn ghost" onClick={() => setCancelling(row)}>Cancel</button>}
                {payable && <button className="btn primary grow" onClick={() => navigate(`/pay/${purpose}/${row.id}`)}>Pay {formatNaira(r.owing)}</button>}
              </div>
            )}
            {path === '/orders' && <div className="row"><Link className="btn primary grow" to={`/orders/${row.id}`}><Truck size={15} aria-hidden="true" /> Track order</Link>{row.items?.length > 0 && <OrderAgain order={row} />}</div>}
            {row.paymentStatus === 'PAID' && <small className="paid"><Check size={13} aria-hidden="true" /> Paid in full</small>}
          </article>
        );
      })}
      {cancelling && (
        <Sheet title="Cancel this?" onClose={() => setCancelling(null)}>
          <Field label="Why are you cancelling? (optional)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="row"><button className="btn ghost" onClick={() => setCancelling(null)}>Keep it</button><button className="btn danger grow" onClick={doCancel}>Yes, cancel</button></div>
        </Sheet>
      )}
    </div>
  );
}

/**
 * Runs a booking or request at once for anyone with a session. A visitor first gives their name, email and phone
 * in a sheet (no password), then the booking carries on. Members can sign in from the same sheet instead.
 */
export function useDetailsFirst() {
  const { pathname, search } = useLocation();
  const [waiting, setWaiting] = useState<null | (() => void)>(null);
  const ask = (run: () => void) => {
    if (getSession()) run();
    else setWaiting(() => run);
  };
  const sheet = waiting ? (
    <Sheet title="Your details" onClose={() => setWaiting(null)}>
      <DetailsForm title="Who is this for?" onDone={() => { const run = waiting; setWaiting(null); run(); }} />
      <p className="auth-switch">Have an account? <Link to={`/login?next=${encodeURIComponent(pathname + search)}`}>Sign in</Link></p>
    </Sheet>
  ) : null;
  return { ask, sheet };
}

/**
 * Where a service happens. "Either" lets the customer choose between our place and their home; a home visit
 * then needs one of their saved addresses (a visitor gives their details first, then adds one).
 */
export function WhereChooser({ mode, feeMinor, venue, atHome, setAtHome, addressId, setAddressId }: {
  mode: 'AT_VENUE' | 'AT_HOME' | 'EITHER';
  feeMinor?: number | null;
  venue: string;
  atHome: boolean;
  setAtHome: (v: boolean) => void;
  addressId: string;
  setAddressId: (id: string) => void;
}) {
  const session = useSession();
  const details = useDetailsFirst();
  const [adding, setAdding] = useState(false);
  const home = mode === 'AT_HOME' || (mode === 'EITHER' && atHome);
  const addresses = useLoad(() => (home && session ? get('/me/addresses').then(rows) : Promise.resolve([] as any[])), [home, session?.email]);
  useEffect(() => {
    const list = addresses.data ?? [];
    if (home && list.length && !list.some((a: any) => a.id === addressId)) setAddressId((list.find((a: any) => a.isDefault) ?? list[0]).id);
    if (home && session && addresses.data && !list.length) setAdding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.data, home]);
  if (mode === 'AT_VENUE') return null;
  const fee = feeMinor ? ` (+${formatNaira(feeMinor)})` : '';
  return (
    <div className="where">
      {mode === 'EITHER'
        ? (
          <div className="segmented" role="group" aria-label="Where">
            <button type="button" className={!atHome ? 'on' : ''} onClick={() => setAtHome(false)}>{venue}</button>
            <button type="button" className={atHome ? 'on' : ''} onClick={() => setAtHome(true)}><MapPin size={15} aria-hidden="true" /> At my home{fee}</button>
          </div>
        )
        : <p className="muted-text"><MapPin size={14} aria-hidden="true" /> We come to you{fee}.</p>}
      {home && !session && (
        <>
          <button type="button" className="btn ghost full" onClick={() => details.ask(() => undefined)}>Add your details, then your address</button>
          {details.sheet}
        </>
      )}
      {home && session && (
        <>
          {(addresses.data ?? []).map((a: any) => (
            <label key={a.id} className={`choice ${addressId === a.id ? 'on' : ''}`}>
              <input type="radio" name="visit-address" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
              <MapPin size={18} aria-hidden="true" />
              <span><b>{a.label ?? a.recipientName}</b><small>{addressLine(a)}</small></span>
            </label>
          ))}
          {adding
            ? <AddressForm onCancel={addresses.data?.length ? () => setAdding(false) : undefined} onSaved={async (a) => { await addresses.reload(); setAddressId(a.id); setAdding(false); }} />
            : <button type="button" className="btn ghost full" onClick={() => setAdding(true)}>Add an address</button>}
        </>
      )}
    </div>
  );
}

const DEPARTMENT: Record<string, string> = {
  'water-drinks-wines': 'Water, drinks & wines',
  'luxury-apartments': 'Luxury Apartments',
  automobiles: 'Cars',
  'spa-wellness': 'Spa',
  'pharmacy-laboratory': 'Pharmacy & lab',
  'retail-general-supplies': 'Supplies',
};

/** What Royalty membership gives, with the live points rates; join or sign in from here. */
export function RoyaltyPage() {
  const session = useSession();
  const me = useLoad(() => (session ? get('/auth/me') : Promise.resolve(null)), [session?.email]);
  const rules = useLoad(() => get('/loyalty/rules').then(rows).catch(() => [] as any[]), []);
  const m = me.data;
  const member = !!session && !!m && !m.isGuest;
  const rates = (rules.data ?? []).filter((r: any) => r.isActive);
  return (
    <>
      <PageTitle title="Royalty Member" />
      <section className="royalty-card" aria-label="Royalty membership card">
        <div className="rc-top">
          <span className="rc-brand">NIMPAT ONE</span>
          <Crown size={28} aria-hidden="true" />
        </div>
        <span className="rc-label">Royalty Member</span>
        {member && m.loyalty ? (
          <p className="rc-points"><b>{Number(m.loyalty.pointsBalance).toLocaleString('en-NG')}</b> points</p>
        ) : (
          <p className="rc-pitch">Every naira you spend with Nimpat earns you points.</p>
        )}
        <div className="rc-foot">
          <span>{member ? [m.firstName, m.lastName].filter(Boolean).join(' ') : 'Your name here'}</span>
          {member && <span>{m.loyalty?.tier ?? 'GREEN'}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>How it works</h2>
        <ol className="rc-steps">
          <li><b>Join</b><small>Create an account with your email and a password.</small></li>
          <li><b>Pay for orders and bookings</b><small>Water and drinks, apartments, the spa, cars and more.</small></li>
          <li><b>Collect points</b><small>They are added as soon as your payment is confirmed.</small></li>
        </ol>
      </section>

      <section className="panel royalty-benefits">
        <h2>What you get</h2>
        <div className="benefit"><Award size={20} aria-hidden="true" /><span><b>Points on every payment</b><small>Paid orders and bookings earn points automatically.</small></span></div>
        <div className="benefit"><Gift size={20} aria-hidden="true" /><span><b>Bonus points and member offers</b><small>Extra points and deals, just for members.</small></span></div>
        <div className="benefit"><Smartphone size={20} aria-hidden="true" /><span><b>Your orders on any device</b><small>Sign in anywhere to see your orders, bookings and points.</small></span></div>
      </section>

      {rates.length > 0 && (
        <section className="panel">
          <h2>How many points</h2>
          {rates.map((r: any) => (
            <div key={r.id} className="sum"><span>{DEPARTMENT[r.division?.slug] ?? r.division?.name}</span><span>{(r.pointsPer100NgnX100 / 100).toLocaleString('en-NG')} {r.pointsPer100NgnX100 === 100 ? 'point' : 'points'} per ₦100</span></div>
          ))}
          <small className="muted-text">Points are added once a payment is confirmed, and taken back if it is refunded.</small>
        </section>
      )}

      {!session && (
        <div className="row">
          <Link className="btn primary grow" to="/register?next=/royalty">Join</Link>
          <Link className="btn ghost grow" to="/login?next=/royalty">Sign in</Link>
        </div>
      )}
      {session && m?.isGuest && <GuestUpgrade onDone={() => void me.reload()} />}
      {member && <Link className="btn ghost full" to="/bookings">See my orders</Link>}
    </>
  );
}

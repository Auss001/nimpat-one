import { FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Field } from '../components/ui';

/** Where invited staff choose their password. The link is valid for 72 hours and works once. */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: password } }, false);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      {done ? (
        <div className="card login">
          <h1>Password set</h1>
          <p className="muted" style={{ margin: 0 }}>You can now sign in with your email and new password.</p>
          <Link className="btn primary" to="/">Go to sign in</Link>
        </div>
      ) : !token ? (
        <div className="card login">
          <h1>Link not valid</h1>
          <p className="muted" style={{ margin: 0 }}>This link is incomplete. Ask your administrator for a new invitation.</p>
        </div>
      ) : (
        <form className="card login" onSubmit={submit}>
          <div>
            <h1>Set your password</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>Use at least 10 characters, with at least one letter and one number.</p>
          </div>
          {error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
          <Field label="New password">
            <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label="Repeat password">
            <input type="password" autoComplete="new-password" minLength={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </Field>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
        </form>
      )}
    </div>
  );
}

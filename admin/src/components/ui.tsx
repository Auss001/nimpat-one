import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { formatNaira, parseNaira, toNairaInput } from '../money';

// ---------------------------------------------------------------- data loading

/** Loads data and exposes reload(); errors are shown by the caller. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

// ---------------------------------------------------------------- toasts

const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const push = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, msg, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with success/error toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        await fn();
        if (success) toast(success);
        return true;
      } catch (e) {
        toast((e as Error).message, 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------------------------------------------------------------- layout bits

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="toolbar" style={{ margin: 0 }}>{actions}</div>}
    </div>
  );
}

export function Loading({ error, loading }: { error?: string | null; loading?: boolean }) {
  if (error) return <div className="banner error">{error}</div>;
  if (loading) return <div className="spinner">Loading…</div>;
  return null;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * In-app confirmation (instead of the browser's window.confirm).
 * const { ask, dialog } = useConfirm();  ask('Remove X?', () => doIt());  render {dialog}
 */
export function useConfirm() {
  const [state, setState] = useState<{ message: string; action: string; onYes: () => void } | null>(null);
  const ask = useCallback((message: string, onYes: () => void, action = 'Yes, continue') => setState({ message, action, onYes }), []);
  const dialog = state ? (
    <Modal
      title="Please confirm"
      onClose={() => setState(null)}
      footer={
        <>
          <button className="btn" onClick={() => setState(null)}>Cancel</button>
          <button className="btn primary" onClick={() => { const fn = state.onYes; setState(null); fn(); }}>{state.action}</button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{state.message}</p>
    </Modal>
  ) : null;
  return { ask, dialog };
}

export function Field({ label, hint, children, full }: { label: string; hint?: string; children: ReactNode; full?: boolean }) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ tone, children }: { tone?: 'green' | 'amber' | 'red' | 'blue' | 'orange'; children: ReactNode }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, 'green' | 'amber' | 'red' | 'blue'> = {
    ACTIVE: 'green', AVAILABLE: 'green', PAID: 'green', SUCCESS: 'green', CONFIRMED: 'green', ACCEPTED: 'green', DELIVERED: 'green', COMPLETED: 'green',
    DRAFT: 'amber', PENDING: 'amber', UNPAID: 'amber', AWAITING_VERIFICATION: 'amber', HOLD: 'amber', RESERVED: 'amber', REQUESTED: 'amber',
    PROCESSING: 'blue', READY: 'blue', PARTIALLY_PAID: 'blue', OUT_FOR_DELIVERY: 'blue', CHECKED_IN: 'blue', SOLD: 'blue',
    ARCHIVED: 'red', INACTIVE: 'red', CANCELLED: 'red', EXPIRED: 'red', REFUNDED: 'red', FAILED: 'red', REJECTED: 'red', REVERSED: 'red', ABANDONED: 'red',
  };
  return <Pill tone={tone[status]}>{status.replace(/_/g, ' ').toLowerCase()}</Pill>;
}

// ---------------------------------------------------------------- money inputs

/** Naira text input bound to a kobo value. */
export function MoneyInput({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  const [text, setText] = useState(toNairaInput(value));
  useEffect(() => setText(toNairaInput(value)), [value]);
  return (
    <input
      inputMode="decimal"
      placeholder={placeholder ?? '0'}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === '' ? null : parseNaira(e.target.value));
      }}
    />
  );
}

/** Click-to-edit price: shows ₦ value; Enter saves, Escape cancels. */
export function InlinePrice({ minor, onSave }: { minor: number; onSave: (kobo: number) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  if (!editing) {
    return (
      <span className="price-cell" title="Click to change the price" onClick={() => { setText(toNairaInput(minor)); setEditing(true); }}>
        {formatNaira(minor)}
      </span>
    );
  }
  const save = async () => {
    const kobo = parseNaira(text);
    if (kobo === null) return;
    if (kobo === minor) return setEditing(false);
    setSaving(true);
    const ok = await onSave(kobo);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <input
      autoFocus
      className="inline-money"
      disabled={saving}
      value={text}
      aria-label="New price in naira"
      style={parseNaira(text) === null ? { borderColor: 'var(--danger)' } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => !saving && setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void save();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

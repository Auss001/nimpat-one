import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Heart, Phone, X } from 'lucide-react';
import { del, get, getSession, PHONE, PHONE_LABEL, post, rows, SHOP_DIVISIONS } from './api';

// ---------------------------------------------------------------- data loading

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
  return { data, error, loading, reload: load };
}

export function useSession() {
  const [session, setSession] = useState(getSession());
  useEffect(() => {
    const on = () => setSession(getSession());
    window.addEventListener('nimpat-session', on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener('nimpat-session', on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return session;
}

// ---------------------------------------------------------------- toasts

const ToastCtx = createContext<(message: string, tone?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'error'; id: number } | null>(null);
  const show = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => setToast({ message, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div key={toast.id} className={`toast ${toast.tone}`} role="status">{toast.message}</div>}
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- basket

interface CartState {
  count: number;
  totalMinor: number;
  carts: any[];
  refresh: () => Promise<void>;
}
const CartCtx = createContext<CartState>({ count: 0, totalMinor: 0, carts: [], refresh: async () => undefined });
export const useCart = () => useContext(CartCtx);

export function CartProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [carts, setCarts] = useState<any[]>([]);
  const refresh = useCallback(async () => {
    if (!getSession()) {
      setCarts([]);
      return;
    }
    const all = await Promise.all(SHOP_DIVISIONS.map((d) => get(`/carts/${d}`).catch(() => null)));
    setCarts(all.filter((c) => c && c.lines.length));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, session?.email]);
  const value = useMemo(() => ({ carts, refresh, count: carts.reduce((n, c) => n + c.itemCount, 0), totalMinor: carts.reduce((n, c) => n + Number(c.subtotalMinor), 0) }), [carts, refresh]);
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

// ---------------------------------------------------------------- favourites

interface FavState {
  has: (kind: string, slug: string) => boolean;
  toggle: (kind: string, slug: string) => Promise<void>;
}
const FavCtx = createContext<FavState>({ has: () => false, toggle: async () => undefined });

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const toast = useToast();
  useEffect(() => {
    if (!session) {
      setSaved(new Set());
      return;
    }
    get('/me/favorites').then((r) => setSaved(new Set(rows(r).map((f: any) => `${f.kind}:${f.itemSlug}`)))).catch(() => undefined);
  }, [session?.email]);
  const value = useMemo<FavState>(() => ({
    has: (kind, slug) => saved.has(`${kind}:${slug}`),
    toggle: async (kind, slug) => {
      const key = `${kind}:${slug}`;
      const on = saved.has(key);
      const flip = (add: boolean) => setSaved((s) => {
        const next = new Set(s);
        if (add) next.add(key);
        else next.delete(key);
        return next;
      });
      flip(!on); // Answer at once; put it back if the server says no.
      try {
        if (on) await del(`/me/favorites/${kind}/${slug}`);
        else await post('/me/favorites', { kind, slug });
      } catch (e) {
        flip(on);
        toast((e as Error).message, 'error');
      }
    },
  }), [saved, toast]);
  return <FavCtx.Provider value={value}>{children}</FavCtx.Provider>;
}

export function FavButton({ kind, slug, inline }: { kind: string; slug: string; inline?: boolean }) {
  const { has, toggle } = useContext(FavCtx);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const on = has(kind, slug);
  return (
    <button
      type="button"
      className={`fav ${on ? 'on' : ''} ${inline ? 'inline' : ''}`}
      aria-label={on ? 'Remove from favourites' : 'Add to favourites'}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!getSession()) navigate(`/login?next=${encodeURIComponent(pathname)}`);
        else void toggle(kind, slug);
      }}
    >
      <Heart size={18} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------- remembered on this device

const remember = <T,>(key: string, limit: number, item: T, same: (x: T) => boolean) => {
  try {
    const list: T[] = JSON.parse(localStorage.getItem(key) ?? '[]');
    localStorage.setItem(key, JSON.stringify([item, ...list.filter((x) => !same(x))].slice(0, limit)));
  } catch {
    /* Storage unavailable: nothing is remembered. */
  }
};
const recall = <T,>(key: string): T[] => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
};
export interface Viewed { slug: string; name: string; image?: string | null }
export const rememberViewed = (p: Viewed) => remember('nimpat-one-viewed', 10, p, (x) => x.slug === p.slug);
export const viewedProducts = () => recall<Viewed>('nimpat-one-viewed');
export const rememberSearch = (q: string) => remember('nimpat-one-searches', 6, q, (x) => x.toLowerCase() === q.toLowerCase());
export const recentSearches = () => recall<string>('nimpat-one-searches');
export const forgetSearches = () => {
  try {
    localStorage.removeItem('nimpat-one-searches');
  } catch {
    /* Nothing to forget. */
  }
};

// ---------------------------------------------------------------- small parts

/** A product or place photo. When there is none, it says so rather than showing something similar. */
export function Photo({ src, alt, fit = 'cover' }: { src?: string | null; alt: string; fit?: 'cover' | 'contain' }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="photo pending" role="img" aria-label={`${alt}: image pending`}>
        <img src="/nimpat-one-logo.webp" alt="" />
        <span>Image pending</span>
      </div>
    );
  }
  return <img className={`photo ${fit}`} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export function Loader({ label = 'Loading' }: { label?: string }) {
  return <div className="loader" role="status"><span className="arcs" aria-hidden="true" />{label}</div>;
}

/** Soft placeholder cards, so a page keeps its shape while it loads. */
export function Skeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="grid" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, n) => <div key={n} className="card skeleton"><span /><i /><i /></div>)}
    </div>
  );
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`note ${tone}`}>{children}</div>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="arcs big" aria-hidden="true" />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PageTitle({ title, sub, back = true, action }: { title: string; sub?: ReactNode; back?: boolean; action?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="page-title">
      {back && <button className="icon-btn" aria-label="Go back" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>}
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CallLink() {
  return <a className="btn ghost" href={`tel:${PHONE}`}><Phone size={16} aria-hidden="true" /> Call {PHONE_LABEL}</a>;
}

const STATUS: Record<string, [string, string]> = {
  PENDING: ['Pending', 'amber'], ACCEPTED: ['Accepted', 'green'], PROCESSING: ['Preparing', 'blue'], READY: ['Ready', 'blue'], OUT_FOR_DELIVERY: ['On the way', 'blue'],
  DELIVERED: ['Delivered', 'green'], COMPLETED: ['Completed', 'green'], CANCELLED: ['Cancelled', 'grey'], EXPIRED: ['Expired', 'grey'], HOLD: ['Held for you', 'amber'],
  CONFIRMED: ['Confirmed', 'green'], CHECKED_IN: ['Checked in', 'blue'], REQUESTED: ['Requested', 'amber'], IN_PROGRESS: ['In progress', 'blue'], NO_SHOW: ['Missed', 'grey'],
  UNPAID: ['Not paid', 'amber'], AWAITING_VERIFICATION: ['Checking payment', 'amber'], PARTIALLY_PAID: ['Part paid', 'blue'], PAID: ['Paid', 'green'], REFUNDED: ['Refunded', 'grey'], FAILED: ['Payment failed', 'red'],
  NEW: ['Received', 'amber'], CONTACTED: ['Contacted', 'blue'], SCHEDULED: ['Scheduled', 'green'], CLOSED_WON: ['Closed', 'grey'], CLOSED_LOST: ['Closed', 'grey'],
};
export function Status({ value }: { value: string }) {
  const [label, tone] = STATUS[value] ?? [value.replace(/_/g, ' ').toLowerCase(), 'grey'];
  return <span className={`status ${tone}`}>{label}</span>;
}

export function Rail({ title, to, children }: { title: string; to: string; children: ReactNode }) {
  return (
    <section className="rail">
      <div className="rail-head">
        <h2>{title}</h2>
        <Link to={to}>See all</Link>
      </div>
      <div className="rail-track">{children}</div>
    </section>
  );
}

export const shortDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
export const dateTime = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
/** A calendar date in Lagos, offset by a number of days. */
export function lagosDate(offset = 0): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d);
}

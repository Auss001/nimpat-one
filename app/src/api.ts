/**
 * Client for the Nimpat One API. A 401 triggers one refresh-token rotation
 * before the customer is asked to sign in again.
 */
/** The website reaches the API through its own server; the phone apps call it directly. */
const ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? '';
const BASE = `${ORIGIN}/api/v1`;

/** In the phone apps, photo paths like /media/... must point at the API server. */
function withMediaOrigin<T>(value: T): T {
  if (!ORIGIN) return value;
  const walk = (v: any): any => {
    if (typeof v === 'string') return v.startsWith('/media/') ? ORIGIN + v : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}
const KEY = 'nimpat-one-session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
  firstName?: string;
  /** Checking out without an account. */
  guest?: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* Storage unavailable: the session lasts for this tab only. */
  }
  window.dispatchEvent(new Event('nimpat-session'));
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const s = getSession();
  if (!s) return false;
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: s.refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) return false;
      const t = await r.json();
      saveSession({ ...s, accessToken: t.accessToken, refreshToken: t.refreshToken });
      return true;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, retry = true): Promise<T> {
  const s = getSession();
  const isForm = opts.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
        ...opts.headers,
      },
      body: isForm ? (opts.body as FormData) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'We could not reach Nimpat One. Please check your connection and try again.');
  }
  if (res.status === 401 && retry && s && (await refresh())) return api<T>(path, opts, false);
  if (res.status === 401 && s) saveSession(null);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* A non-JSON answer falls through to the general message below. */
  }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('. ') : data?.message;
    throw new ApiError(res.status, msg ?? 'Something went wrong. Please try again.');
  }
  return withMediaOrigin(data) as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: unknown = {}, headers?: Record<string, string>) => api<T>(p, { method: 'POST', body, headers });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'DELETE', body });

/** Some lists arrive bare and some inside `{ data, meta }`. */
export const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.data ?? []));

/** Makes a repeated tap on a pay or order button safe. */
export const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });

function startSession(r: { accessToken: string; refreshToken: string; user: { email: string; firstName?: string } }, firstName?: string) {
  saveSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email, firstName: firstName ?? r.user.firstName });
}

export async function login(email: string, password: string) {
  const r = await api<any>('/auth/login', { method: 'POST', body: { email, password } }, false);
  startSession(r);
  const me = await get<any>('/auth/me').catch(() => null);
  const s = getSession();
  if (s && me?.customerProfile?.firstName) saveSession({ ...s, firstName: me.customerProfile.firstName });
}

export async function register(body: { email: string; password: string; firstName: string; lastName: string; phone?: string }) {
  startSession(await api<any>('/auth/register', { method: 'POST', body }, false), body.firstName);
}

/** Accepts 0803..., 803... or +234803... and returns +234803... */
export function nigerianPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+234')) return digits;
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  return `+234${digits}`;
}

/** Buy without an account. Guests do not earn Royalty points. */
export async function startGuest(body: { email: string; firstName: string; lastName: string; phone: string }) {
  const r = await api<any>('/auth/guest', { method: 'POST', body }, false);
  saveSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email, firstName: body.firstName, guest: true });
}

/** Turns the guest into a full account with a password; their orders stay. */
export async function upgradeGuest(password: string) {
  const user = await api<any>('/auth/guest/upgrade', { method: 'POST', body: { password } });
  const s = getSession();
  if (s) saveSession({ ...s, email: user.email, guest: false });
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST', body: {} }, false);
  } catch {
    /* Already signed out. */
  }
  saveSession(null);
}

export const endSession = () => saveSession(null);

export function formatNaira(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  const whole = Math.floor(Number(minor) / 100).toLocaleString('en-NG');
  const kobo = Number(minor) % 100;
  return `₦${whole}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;
}

export const SHOP_DIVISIONS = ['water-drinks-wines', 'pharmacy-laboratory', 'retail-general-supplies'];
export const PHONE = '+2348188336209';
export const PHONE_LABEL = '+234 818 833 6209';

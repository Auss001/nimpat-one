/**
 * Minimal API client for the Nimpat One API. Tokens are kept in
 * localStorage so staff stay signed in across reloads; a 401 triggers one
 * refresh-token rotation before giving up.
 */
const BASE = '/api/v1';
const KEY = 'nimpat-admin-session';

interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
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
    /* storage unavailable — session lasts for this tab only */
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
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && retry && s && (await refresh())) return api<T>(path, opts, false);
  if (res.status === 401 && s) saveSession(null);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('; ') : data?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export async function login(email: string, password: string) {
  const r = await api<{ accessToken: string; refreshToken: string; user: { type: string; email: string } }>(
    '/auth/login',
    { method: 'POST', body: { email, password } },
    false,
  );
  if (r.user.type !== 'STAFF') throw new ApiError(403, 'This account is not a staff account.');
  saveSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email });
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' }, false);
  } catch {
    /* already signed out */
  }
  saveSession(null);
}

/** Downloads a protected file (e.g. proof of payment) and opens it in a new tab. */
export async function openProtectedFile(path: string) {
  const s = getSession();
  const res = await fetch(`${BASE}${path}`, { headers: s ? { Authorization: `Bearer ${s.accessToken}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Could not open the file');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const get = <T = any>(p: string) => api<T>(p);
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

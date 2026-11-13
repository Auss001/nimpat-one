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

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}, retry = true): Promise<T> {
  const s = getSession();
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
      ...opts.headers,
    },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
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

/** Downloads a protected file (e.g. a spreadsheet export) to the computer under the given name. */
export async function downloadFile(path: string, filename: string) {
  const s = getSession();
  const res = await fetch(`${BASE}${path}`, { headers: s ? { Authorization: `Bearer ${s.accessToken}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Could not download the file');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const get = <T = any>(p: string) => api<T>(p);
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Reads every page of a list, for screens that search and filter in the browser. */
export async function getAll<T = any>(path: string): Promise<T[]> {
  const sep = path.includes('?') ? '&' : '?';
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const r = await get<{ data: T[]; meta: { totalPages: number } }>(`${path}${sep}pageSize=100&page=${page}`);
    out.push(...r.data);
    if (page >= r.meta.totalPages) return out;
  }
}

/** Sends one file as a form upload. */
export function upload<T = any>(p: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', file);
  return api<T>(p, { method: 'POST', form });
}

/** A guest's real email and phone are kept apart from their internal sign-in address. */
type Contact = { email?: string; phone?: string | null; isGuest?: boolean; contactEmail?: string | null; contactPhone?: string | null } | null | undefined;
export const contactEmail = (u: Contact) => (u?.isGuest ? `${u.contactEmail ?? ''} (guest)` : (u?.email ?? ''));
export const contactPhone = (u: Contact) => (u?.isGuest ? u.contactPhone : u?.phone) ?? null;

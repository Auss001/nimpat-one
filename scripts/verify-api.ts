/**
 * Live API verification against a running server (default http://localhost:4000).
 *
 *   npx ts-node --transpile-only scripts/verify-api.ts > docs/api-verification.json
 *
 * For every operation in the served OpenAPI document it calls the endpoint:
 *   1. with no token          → protected routes must answer 401
 *   2. as a fresh customer    → staff (/admin) routes must answer 403
 *   3. as the seeded admin    → the route must exist (never 404 for a bad path / 500)
 * Path parameters are filled with a random UUID, so "404 Not Found (record)"
 * and "400 validation" are expected and count as "implemented".
 * It also checks health, Swagger, CORS and database connectivity.
 *
 * Read-only by design: it only sends GET requests to admin routes and
 * empty bodies to POST/PATCH (which fail validation before any write).
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'dev.admin@nimpat.test';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

type Result = { method: string; path: string; public: boolean; staff: boolean; anon: number; customer: number; admin: number; ok: boolean; note?: string };

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  const report: Record<string, unknown> = { base: BASE, at: new Date().toISOString() };

  const live = await call('GET', '/health/live');
  const ready = await call('GET', '/health/ready');
  report.health = { live: live.status, ready: ready.status, database: ready.json?.database };
  const spec = await call('GET', '/api/docs/openapi.json');
  const ui = await fetch(BASE + '/api/docs');
  report.swagger = { ui: ui.status, spec: spec.status, title: spec.json?.info?.title, version: spec.json?.info?.version, openapi: spec.json?.openapi };

  // CORS
  const allowed = await fetch(BASE + '/api/v1/divisions', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
  const blocked = await fetch(BASE + '/api/v1/divisions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  report.cors = {
    allowedOrigin: { status: allowed.status, allowOrigin: allowed.headers.get('access-control-allow-origin'), allowHeaders: allowed.headers.get('access-control-allow-headers'), credentials: allowed.headers.get('access-control-allow-credentials') },
    unknownOrigin: { status: blocked.status, allowOrigin: blocked.headers.get('access-control-allow-origin') },
  };

  // Tokens
  const email = `verify.${Date.now()}@example.test`;
  const reg = await call('POST', '/api/v1/auth/register', undefined, { email, password: 'verify-script-pass-1', firstName: 'Verify', lastName: 'Script' });
  const customerToken: string | undefined = reg.json?.accessToken;
  const adminLogin = await call('POST', '/api/v1/auth/login', undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const adminToken: string | undefined = adminLogin.json?.accessToken;
  report.tokens = { customer: !!customerToken, admin: !!adminToken, adminLoginStatus: adminLogin.status };

  const results: Result[] = [];
  for (const [rawPath, ops] of Object.entries<any>(spec.json?.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(ops)) {
      const path = rawPath.replace(/\{[^}]+\}/g, randomUUID());
      const isPublic = !op.security?.length;
      const isStaff = rawPath.includes('/admin/') || rawPath.includes('/loyalty/admin/');
      const m = method.toUpperCase();
      const body = m === 'GET' || m === 'DELETE' ? undefined : {};
      // Never send state-changing requests as admin; GETs only.
      const anon = (await call(m, path, undefined, body)).status;
      // Calling logout with the shared customer token would end its session for the rest of the run.
      const endsSession = /\/auth\/(logout|logout-all)$/.test(rawPath);
      const customer = customerToken && !endsSession ? (await call(m, path, customerToken, body)).status : endsSession ? -1 : 0;
      const admin = adminToken && m === 'GET' ? (await call(m, path, adminToken)).status : -1;
      let ok = true;
      let note: string | undefined;
      if (!isPublic && anon !== 401) { ok = false; note = `expected 401 without token, got ${anon}`; }
      if (isStaff && customer !== 403) { ok = false; note = `expected 403 for customer, got ${customer}`; }
      if ([anon, customer, admin].includes(500)) { ok = false; note = 'server error'; }
      if (admin === 404 && !rawPath.includes('{')) { ok = false; note = 'admin GET returned 404 on a static path'; }
      results.push({ method: m, path: rawPath, public: isPublic, staff: isStaff, anon, customer, admin, ok, note });
    }
  }
  report.routes = { total: results.length, public: results.filter((r) => r.public).length, staff: results.filter((r) => r.staff).length, failures: results.filter((r) => !r.ok) };
  report.routeTable = results;
  process.stdout.write(JSON.stringify(report, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

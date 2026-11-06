/**
 * Basic load test for a LOCAL API instance. Refuses any non-local address.
 *
 *   API_BASE=http://localhost:4010 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:load
 *
 * Runs against a server started with a high RATE_LIMIT_MAX and the test
 * database. Prints JSON: requests per second, latency percentiles and errors
 * per scenario, plus a stock-consistency check after concurrent checkouts.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:4010';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Load test only runs against localhost');
const API = `${BASE}/api/v1`;
const SECONDS = Number(process.env.LOAD_SECONDS ?? 15);
const SKU = 'DEV-WATER-JAR';

type Call = () => Promise<number>;

async function json(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function scenario(name: string, concurrency: number, calls: (worker: number) => Call) {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const end = Date.now() + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, w) => {
      const call = calls(w);
      while (Date.now() < end) {
        const t = performance.now();
        let s = 0;
        try {
          s = await call();
        } catch {
          s = 0;
        }
        latencies.push(performance.now() - t);
        statuses[s] = (statuses[s] ?? 0) + 1;
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]);
  const serverErrors = Object.entries(statuses).filter(([k]) => k === '0' || k.startsWith('5')).reduce((n, [, v]) => n + v, 0);
  return { name, concurrency, seconds: SECONDS, requests: latencies.length, perSecond: Math.round(latencies.length / SECONDS), p50ms: pct(0.5), p95ms: pct(0.95), p99ms: pct(0.99), serverErrors, statuses };
}

async function main() {
  const login = await json('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  if (!login.body?.accessToken) throw new Error(`Admin login failed (${login.status})`);
  const admin = login.body.accessToken as string;

  const products = await json('GET', '/catalog/products?division=water-drinks-wines&q=' + SKU);
  const variant = products.body.data[0]?.variants.find((v: any) => v.sku === SKU);
  if (!variant) throw new Error(`${SKU} is not on sale in this database`);
  const levels = await json('GET', '/admin/inventory?division=water-drinks-wines&pageSize=100', undefined, admin);
  const level = levels.body.data.find((l: any) => l.variant.sku === SKU);
  await json('POST', '/admin/inventory/adjustments', { variantId: variant.id, locationId: level.location.id, delta: 200000, type: 'RECEIPT', reason: 'Load test stock' }, admin);

  const customers: string[] = [];
  for (let i = 0; i < 16; i++) {
    const r = await json('POST', '/auth/register', { email: `load.${Date.now()}.${i}@example.test`, password: 'load-test-pass-123', firstName: 'Load', lastName: 'Test' });
    if (r.status !== 201) throw new Error(`Register failed: ${r.status}`);
    customers.push(r.body.accessToken);
  }

  const results = [];
  results.push(await scenario('Health (no database)', 50, () => () => fetch(`${BASE}/health/live`).then((r) => r.status)));
  results.push(await scenario('Product catalogue list', 50, () => () => fetch(`${API}/catalog/products?division=water-drinks-wines&pageSize=20`).then(async (r) => { await r.arrayBuffer(); return r.status; })));
  results.push(await scenario('Signed-in profile', 50, (w) => () => json('GET', '/auth/me', undefined, customers[w % customers.length]).then((r) => r.status)));
  results.push(await scenario('Cart + checkout (writes, stock reservation)', 16, (w) => async () => {
    const token = customers[w % customers.length];
    const add = await json('POST', '/carts/items', { variantId: variant.id, quantity: 1 }, token);
    if (add.status !== 201) return add.status;
    const order = await json('POST', '/orders', { division: 'water-drinks-wines', fulfilmentType: 'PICKUP' }, token);
    return order.status;
  }));

  const after = await json('GET', '/admin/inventory?division=water-drinks-wines&pageSize=100', undefined, admin);
  const a = after.body.data.find((l: any) => l.variant.sku === SKU);
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), environment: 'single API process + PostgreSQL in Docker, developer machine', results, stock: { onHand: a.quantityOnHand, reserved: a.quantityReserved, consistent: a.quantityReserved <= a.quantityOnHand } }, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

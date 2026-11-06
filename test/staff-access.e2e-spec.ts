import { API, Harness } from './harness';

/** Inviting managers, what they may change, and what the homepage overview shows them. */
const h = new Harness();
const PASSWORD = 'manager-pass-12345';
let admin: { auth: object };
let drinks: { id: string };
let retail: { id: string };
let n = 0;

async function invite(role: string, divisionId?: string, by: object = admin.auth, expected = 201) {
  const stamp = `${Date.now()}.${++n}`;
  const email = `access.${stamp}@nimpat.test`;
  const res = await h.http.post(`${API}/admin/staff`).set(by).send({ email, firstName: 'Ada', lastName: 'Test', employeeNumber: `AC-${stamp}`, role, divisionId });
  expect(res.status).toBe(expected);
  return { email, id: res.body.id as string, inviteLink: res.body.inviteLink as string | null };
}

async function signIn(person: { email: string; inviteLink: string | null }) {
  const token = new URL(person.inviteLink as string).searchParams.get('token');
  await h.http.post(`${API}/auth/reset-password`).send({ token, newPassword: PASSWORD }).expect(200);
  const login = await h.http.post(`${API}/auth/login`).send({ email: person.email, password: PASSWORD }).expect(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

beforeAll(async () => {
  await h.start();
  admin = await h.admin();
  drinks = await h.prisma.division.findUniqueOrThrow({ where: { slug: 'water-drinks-wines' } });
  retail = await h.prisma.division.findUniqueOrThrow({ where: { slug: 'retail-general-supplies' } });
});
afterAll(() => h.stop());

describe('inviting staff', () => {
  it('gives a link to the dashboard while email is not connected', async () => {
    const person = await invite('DEPARTMENT_MANAGER', drinks.id);
    expect(person.inviteLink).toContain('/reset-password?token=');
    expect(person.inviteLink).toContain(process.env.ADMIN_PUBLIC_URL ?? 'http://localhost:3001');
    await signIn(person);
  });

  it('can replace an invitation until the person first signs in', async () => {
    const person = await invite('DEPARTMENT_STAFF', drinks.id);
    const again = await h.http.post(`${API}/admin/users/${person.id}/invite`).set(admin.auth).send({}).expect(201);
    expect(again.body.inviteLink).toContain('/reset-password?token=');
    await signIn({ ...person, inviteLink: again.body.inviteLink });
    await h.http.post(`${API}/admin/users/${person.id}/invite`).set(admin.auth).send({}).expect(400);
  });

  it('does not let a manager issue an invitation for someone outside their division', async () => {
    const manager = await signIn(await invite('DEPARTMENT_MANAGER', drinks.id));
    const other = await invite('DEPARTMENT_STAFF', retail.id);
    await h.http.post(`${API}/admin/users/${other.id}/invite`).set(manager).send({}).expect(403);
    const finance = await invite('FINANCE_OFFICER');
    await h.http.post(`${API}/admin/users/${finance.id}/invite`).set(manager).send({}).expect(403);
  });
});

describe('what a manager can do', () => {
  let manager: object;
  let drinksProduct: { id: string; variants: { id: string }[] };
  let retailProduct: { id: string; variants: { id: string }[] };

  const create = async (division: string) => {
    const stamp = `${Date.now()}${++n}`;
    const res = await h.http.post(`${API}/admin/catalog/products`).set(admin.auth).send({
      division, name: `Access Test ${stamp}`, slug: `access-test-${stamp}`, variants: [{ sku: `ACCESS-${stamp}`, name: 'Single', unitPriceMinor: 100000 }],
    }).expect(201);
    return res.body;
  };

  beforeAll(async () => {
    manager = await signIn(await invite('DEPARTMENT_MANAGER', drinks.id));
    drinksProduct = await create('water-drinks-wines');
    retailProduct = await create('retail-general-supplies');
  });

  it('changes names and prices, and removes products, in their own division', async () => {
    await h.http.patch(`${API}/admin/catalog/products/${drinksProduct.id}`).set(manager).send({ name: 'Renamed by manager' }).expect(200);
    await h.http.patch(`${API}/admin/catalog/variants/${drinksProduct.variants[0].id}`).set(manager).send({ unitPriceMinor: 250000 }).expect(200);
    const saved = await h.prisma.productVariant.findUnique({ where: { id: drinksProduct.variants[0].id } });
    expect(Number(saved.unitPriceMinor)).toBe(250000);
    await h.http.patch(`${API}/admin/catalog/products/${drinksProduct.id}`).set(manager).send({ status: 'ARCHIVED' }).expect(200);
  });

  it('cannot touch another division', async () => {
    await h.http.patch(`${API}/admin/catalog/products/${retailProduct.id}`).set(manager).send({ name: 'Should fail' }).expect(403);
    await h.http.patch(`${API}/admin/catalog/variants/${retailProduct.variants[0].id}`).set(manager).send({ unitPriceMinor: 1 }).expect(403);
  });

  it('records who changed a price', async () => {
    const log = await h.prisma.auditLog.findFirst({ where: { entityId: drinksProduct.variants[0].id }, orderBy: { createdAt: 'desc' } });
    expect(log).toBeTruthy();
  });

  it('can add staff to their own division only, and cannot create other managers', async () => {
    await invite('DEPARTMENT_STAFF', drinks.id, manager);
    await invite('DEPARTMENT_STAFF', retail.id, manager, 403);
    await invite('DEPARTMENT_MANAGER', drinks.id, manager, 403);
    await invite('SUPER_ADMIN', undefined, manager, 403);
  });

  it('sees only the staff of their own division', async () => {
    const res = await h.http.get(`${API}/admin/users?type=STAFF&pageSize=100`).set(manager).expect(200);
    const divisions = res.body.data.flatMap((u: { roles: { divisionId: string | null }[] }) => u.roles.map((r) => r.divisionId));
    expect(divisions).toContain(drinks.id);
    expect(res.body.data.every((u: { roles: { divisionId: string | null }[] }) => u.roles.some((r) => r.divisionId === drinks.id))).toBe(true);
  });

  it('loses access at once when suspended, and cannot suspend others', async () => {
    const person = await invite('DEPARTMENT_MANAGER', drinks.id);
    const auth = await signIn(person);
    await h.http.patch(`${API}/admin/users/${person.id}/status`).set(manager).send({ status: 'SUSPENDED' }).expect(403);
    await h.http.patch(`${API}/admin/users/${person.id}/status`).set(admin.auth).send({ status: 'SUSPENDED' }).expect(200);
    await h.http.get(`${API}/auth/me`).set(auth).expect(401);
    await h.http.post(`${API}/auth/login`).send({ email: person.email, password: PASSWORD }).expect((r: { status: number }) => expect(r.status).toBeGreaterThanOrEqual(400));
  });
});

describe('homepage overview', () => {
  it('leaves out test samples and switched-off records', async () => {
    const res = await h.http.get(`${API}/admin/reports/overview`).set(admin.auth).expect(200);
    expect(res.body.scope).toBe('group');
    const real = await h.prisma.product.count({ where: { status: 'ACTIVE', verification: { not: 'DEV_SAMPLE' } } });
    const counted = res.body.holdings.filter((x: { label: string }) => /Drinks|Retail|Pharmacy/.test(x.label)).reduce((a: number, x: { count: number }) => a + x.count, 0);
    expect(counted).toBe(real);
    expect(res.body.stock.total).toBe(res.body.stock.inStock + res.body.stock.low + res.body.stock.out + res.body.stock.uncounted);
    expect(res.body.records.confirmed).toBeLessThanOrEqual(res.body.records.total);
    expect(res.body.apartments.byCondition.reduce((a: number, c: { count: number }) => a + c.count, 0)).toBe(res.body.apartments.total);
  });

  it('keeps a manager to their own division', async () => {
    const manager = await signIn(await invite('DEPARTMENT_MANAGER', retail.id));
    const res = await h.http.get(`${API}/admin/reports/overview`).set(manager).expect(200);
    expect(res.body.scope).toBe('divisions');
    expect(res.body.holdings.every((x: { label: string }) => /Retail/.test(x.label))).toBe(true);
    expect(res.body.apartments.total).toBe(0);
    expect(res.body.revenue.byDivision.every((x: { label: string }) => /Retail/.test(x.label))).toBe(true);
  });

  it('is closed to staff without report access', async () => {
    const staff = await signIn(await invite('DEPARTMENT_STAFF', drinks.id));
    await h.http.get(`${API}/admin/reports/overview`).set(staff).expect(403);
    await h.http.get(`${API}/admin/reports/overview`).expect(401);
  });
});

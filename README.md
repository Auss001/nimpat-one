# Nimpat One — Backend API

The central REST API for **Nimpat One**, the unified digital platform of Nimpat
Group of Companies, Nigeria. A single NestJS service backed by a single
PostgreSQL database serves all eight business divisions plus Entertainment:

1. Nimpat Water, Drinks & Wines — **first complete commercial module**
2. Nimpat Luxury Apartments — booking engine with double-booking protection
3. Nimpat Automobiles · 4. Nimpat Spa & Wellness · 5. Nimpat Transport & Logistics
6. Nimpat Retail & General Supplies · 7. Nimpat Media, Events & Rentals · 8. Nimpat Real Estate & Interior Design
+ Entertainment (discovery category) and Green Wallet loyalty points.
HOVA Lounge & Restaurant is intentionally excluded.

This project is independent. It does not modify the corporate website, the
Antigravity customer app or the earlier `nimpat-one/` monorepo.

| | |
|---|---|
| Runtime | Node.js 22.12+ (developed on 24), TypeScript 5.9 |
| Framework | NestJS 11 (REST, URI versioning `/api/v1`) |
| Database | PostgreSQL 17 + Prisma ORM 6 |
| Docs | OpenAPI 3 / Swagger UI at `/api/docs` |
| Payments | Paystack (test mode only, enforced) |
| Deploy | Docker → Google Cloud Run + Cloud SQL ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the original design, and
start with these for the current state:

- [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md): what works and what was tested
- [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md): what is needed next
- [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md): connecting the customer app
- [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md): API overview and payment rules
- [docs/API_VERIFICATION.md](docs/API_VERIFICATION.md), [docs/PAYSTACK_TESTING.md](docs/PAYSTACK_TESTING.md), [docs/DATA_AUDIT.md](docs/DATA_AUDIT.md)

## Quick start (local)

Prerequisites: Node.js 22.12+ and Docker Desktop.

```bash
cp .env.example .env                 # then set the local passwords and your Paystack TEST keys
npm install
docker compose up -d db              # PostgreSQL 17 on localhost:5432
npx prisma migrate deploy            # create the schema
npm run prisma:seed                  # divisions, roles, dev admin, [DEV SAMPLE] data
npm run start:dev                    # http://localhost:4000
```

* Swagger UI: http://localhost:4000/api/docs
* OpenAPI JSON: http://localhost:4000/api/docs/openapi.json, or `npm run openapi:export` to write `openapi.json` for client code generation
* Health: `/health/live`, `/health/ready`

The seed creates one local **Super Administrator** using `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD` from `.env` (development values only). Sample catalogue
data is always prefixed `[DEV SAMPLE]`. It is not real Nimpat data, and the seed
refuses to load it when `NODE_ENV=production`.

In development, emails (verification, password reset, staff invites) are
printed to the console. That is where to find the links when testing locally.

### Admin dashboard

A staff dashboard lives in [`admin/`](admin/) (React + Vite). It lets staff
edit prices, add or remove products and listings, manage stock and delivery
fees, and handle orders and reservations.

```bash
npm run catalog:import               # load the Nimpat catalogue (safe to re-run)
npm start                            # API on :4000 (after npm run build)
npm --prefix admin install
npm --prefix admin run dev           # dashboard on http://localhost:3001
```

Sign in with the staff account from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
Fonts and colours are set in one place: the variables at the top of
[`admin/src/theme.css`](admin/src/theme.css).

`catalog:import` reads [`prisma/catalog/nimpat-catalog.json`](prisma/catalog/nimpat-catalog.json)
and only creates missing items, so it never overwrites prices changed in the
dashboard. Product photos are served by the API from `media/`.

### Paystack test mode

1. Copy your **test** keys (`sk_test_…`, `pk_test_…`) from the Paystack dashboard into `.env`. The app refuses to start with live keys.
2. To receive webhooks locally, expose port 4000 (for example with `ngrok http 4000`) and set the dashboard webhook URL to `https://<tunnel>/api/v1/payments/webhooks/paystack`.
3. Without webhooks, the client can call `POST /api/v1/payments/verify/:reference` after checkout. The background reconciliation job also verifies open payments every 5 minutes.

## Scripts

| Script | |
|---|---|
| `npm run start:dev` | watch mode |
| `npm run build` / `npm start` | compile to `dist/` / run compiled |
| `npm run typecheck` | TypeScript check incl. tests and seed |
| `npm test` | unit tests |
| `npm run test:e2e` | end-to-end tests against a real PostgreSQL test DB and a mock Paystack |
| `npm run prisma:migrate` | create/apply a new migration in development |
| `npm run prisma:deploy` | apply migrations (CI / production) |
| `npm run prisma:seed` | idempotent seed |
| `npm run openapi:export` | write `openapi.json` |

### End-to-end tests

The e2e suite needs a separate database, `nimpat_one_test`, on the compose
PostgreSQL (or set `TEST_DATABASE_URL`). Create it once:

```bash
docker exec nimpat-one-db psql -U nimpat -d postgres -c "CREATE DATABASE nimpat_one_test"
```

It runs `prisma migrate deploy` and the seed, then starts the app in-process
with a local mock Paystack server. It covers registration, verification,
refresh-token rotation and reuse detection, RBAC division scoping, server-side
pricing, idempotent checkout, concurrent stock contention, payment
verification (including amount mismatch), webhook signatures and replays,
refunds, loyalty points, apartment double-booking races and hold expiry.

## API map (v1)

| Area | Public / customer | Staff (`/admin/...`) |
|---|---|---|
| Auth | `/auth/register, login, refresh, logout, logout-all, verify-email, resend-verification, forgot-password, reset-password, change-password, me` | |
| Account | `/me/profile`, `/me/addresses` | `/admin/users`, `/admin/staff`, `/admin/users/:id/roles`, `/admin/users/:id/status`, `/admin/roles`, `/admin/departments` |
| Divisions | `/divisions` | |
| Catalogue | `/catalog/categories, products, products/:slug, availability` | `/admin/catalog/products, variants, images, categories` |
| Inventory | | `/admin/inventory`, `/adjustments`, `/movements`, `/locations`, `/levels/:id` |
| Delivery | `/delivery/zones`, `/delivery/quote` | `/admin/delivery/zones`, `/admin/delivery/deliveries` |
| Cart | `/carts/:division`, `/carts/:division/quote`, `/carts/items` | |
| Orders | `/orders` (checkout, history, detail, cancel) | `/admin/orders`, `/admin/orders/:id/status` |
| Payments | `/payments/initialize`, `/payments/verify/:reference`, `/payments`, webhook | `/admin/payments`, `/:id/verify`, `/:id/refunds`, `/reconcile` |
| Apartments | `/apartments/properties`, `/units/:id/calendar`, `/units/:id/quote`, `/reservations` | `/admin/apartments/properties, units, blackouts, reservations` |
| Automobiles | `/vehicles`, `/vehicles/:id/inquiries` | `/admin/vehicles`, `/admin/vehicles/inquiries/...` |
| Services | `/services`, `/services/bookings` | `/admin/services`, `/admin/services/bookings` |
| Spa | `/spa/treatments`, `/spa/treatments/:id/slots`, `/spa/appointments` | `/admin/spa/appointments, treatments, practitioners` |
| Logistics | `/logistics/requests`, `/logistics/track/:no` | `/admin/logistics/requests/:id/quote, events` |
| Quotations | `/quotations` (request, accept, reject) | `/admin/quotations`, `/:id/send` |
| Loyalty | `/loyalty/me`, `/loyalty/rules` | `/loyalty/admin/users/:id/adjustments` |
| Notifications | `/notifications` | |
| Reports & audit | | `/admin/reports/summary`, `/admin/reports/low-stock`, `/admin/audit-logs` |

## Conventions

* Money is always an integer in **kobo** (`150000` = ₦1,500.00), in fields named `…Minor`.
* Lists return `{ data, meta: { page, pageSize, total, totalPages } }`.
* Errors return `{ statusCode, error?, message, requestId }`. Send `X-Request-Id` to correlate.
* Send `Idempotency-Key` on checkout, reservations and payment initialisation to make retries safe.
* Dates for stays are `YYYY-MM-DD`. Timestamps are ISO-8601 UTC. The business timezone is Africa/Lagos.

# Nimpat One API reference

The complete, machine-readable reference is the OpenAPI file: `docs/openapi/nimpat-one-api.v1.json` (regenerate with `npm run client:generate`). Swagger UI runs at `/api/docs` outside production. This page is the overview.

Customer journeys, with request and response details, are in [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md). Real responses are in `docs/api-samples.json`.

- **Base path:** `/api/v1`. Health checks: `/health/live`, `/health/ready`.
- **Size:** 174 operations; 30 public, 91 staff.
- **Known limit:** the OpenAPI file fully describes requests, but response bodies are not schema-typed yet. `clients/typescript/index.ts` has hand-written response types, checked by the contract test.

## Customer and public areas

| Area | Paths |
|---|---|
| Auth | `/auth/*` |
| Account | `/me/profile`, `/me/addresses` |
| Divisions, catalogue | `/divisions`, `/catalog/*` |
| Delivery | `/delivery/zones`, `/delivery/quote` |
| Cart, orders | `/carts/*`, `/orders/*` |
| Payments | `/payments/methods`, `/options`, `/summary`, `/initialize`, `/verify/:reference`, `/bank-transfer/*`, `/proofs/:id`, `/receipts/:reference`, `/webhooks/paystack` |
| Bookings | `/apartments/*`, `/spa/*`, `/services/*`, `/vehicles/*` |
| Logistics, quotations | `/logistics/*`, `/quotations/*` |
| Loyalty, notifications | `/loyalty/me`, `/loyalty/rules`, `/notifications/*` |

## Staff areas (`/admin/...`)

| Area | Paths | Permission |
|---|---|---|
| Users, staff, roles | `/admin/users`, `/staff`, `/roles`, `/departments` | `customers:read`, `staff:manage`, `roles:assign` |
| Catalogue, stock, delivery | `/admin/catalog/*`, `/inventory/*`, `/delivery/*` | `catalog:manage`, `inventory:*`, `deliveries:manage` |
| Orders, bookings | `/admin/orders`, `/apartments/*`, `/spa/*`, `/services/*`, `/vehicles/*`, `/logistics/*`, `/quotations/*` | Per area |
| Payments | `/admin/payments` (filters: `division, method, collectionPoint, status, reconciliationStatus, serviceLocationId, reportedById, from, to`) | `payments:read` |
| Record a collection | `POST /admin/collections` | `collections:record` |
| Verify money | `POST /admin/payments/:id/confirm-funds`, `/reject`, `/dispute`, `/resolve-dispute`, `/reverse` | `payments:verify` |
| Reconcile | `POST /admin/payments/:id/reconcile`, `POST /admin/payments/reconcile` (Paystack batch) | `payments:reconcile` |
| Refund (Paystack) | `POST /admin/payments/:id/refunds` | `payments:refund` |
| Finance views | `/admin/finance/outstanding`, `/admin/finance/collections-by-staff` | `payments:read` |
| Payment settings | `/admin/payment-settings/bank-accounts`, `/service-locations`, `/policies` | `payments:configure` |
| Data confirmation | `/admin/records/audit`, `POST /admin/records/verification` | `records:verify` |
| Reports, audit | `/admin/reports/*`, `/admin/audit-logs` | `reports:read`, `audit:read` |
| Jobs | `POST /internal/jobs/expire`, `/reconcile-payments` | `X-Job-Token` header |

## Roles

| Role | Scope | Payment powers |
|---|---|---|
| Super Administrator | Group | Everything, except verifying money they reported themselves |
| Group Management | Group | Read, reconcile |
| **Finance Officer** (new) | Group | Verify, reject, dispute, reverse, reconcile, refund |
| Department Manager | One division | Record collections, refund, read; can confirm catalogue records; cannot verify money |
| Department Staff | One division | Record collections only |
| Customer Support | Group | Read |
| Customer | Own data | Pay, report transfers |

## Payment rules

Paystack is the only gateway. Other methods are ways of paying outside a gateway.

1. **Only `SUCCESS` counts.** Reported transfers and collections are shown as awaiting verification and never raise the paid balance.
2. **`SUCCESS` has two routes:** Paystack's verify API matching reference, amount and currency, or finance confirming against a trusted record.
3. **Separation of duties:** whoever reported a payment can't verify, reject, reverse, resolve or reconcile it, whatever their role.
4. **No double counting:** the order or booking row is locked during settlement, the change happens once, a bank statement reference can settle only one transfer, and reported money can't exceed the balance.
5. **Status is separate:** delivering an order or finishing a service never marks it paid. An order can't be `COMPLETED` until paid in full.
6. **Booking confirmation follows policy:** `FULL_PAYMENT`, `DEPOSIT_VERIFIED` or `STAFF_APPROVAL`, per division and transaction type. Starting a payment confirms nothing.
7. **History is protected:** database triggers stop deletion of payments and audit logs, and rewriting of payment events, audit entries, stock movements and loyalty transactions.
8. **Default settings are cautious:** only Paystack is on until an admin enables other methods, adds a bank account and adds locations. Pay on delivery needs both the division rule and the zone switch.

## Environment

See `.env.example`. Live Paystack keys are refused at startup. In production, placeholder JWT and job secrets are refused too.

## Tests and scripts

| Command | Purpose |
|---|---|
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests on the `nimpat_one_test` database |
| `PAYSTACK_LIVE_TEST_KEY=sk_test_… npm run test:paystack` | Real Paystack test mode |
| `npm run test:load` | Local load test (localhost only) |
| `scripts/verify-api.ts` | Live route and authorization check |
| `npm run client:generate` | Regenerate the OpenAPI file and client types |

# Nimpat One API: architecture

> Written before the multi-method payment work. For payment rules, order statuses and roles, [API_DOCUMENTATION.md](API_DOCUMENTATION.md) is current and takes precedence over sections 5 and 6 below.

## 1. Shape

One NestJS application and one PostgreSQL database for all eight Nimpat
divisions plus the Entertainment discovery category. Each business area is
its own module. Shared concerns (auth, RBAC, payments, notifications, audit,
loyalty) are written once and reused.

```
src/
  main.ts / bootstrap.ts        HTTP setup: helmet, CORS, validation, versioning (/api/v1), Swagger
  config/                       typed, validated environment (startup fails on bad config)
  prisma/                       PrismaService (+ transaction client type)
  common/                       guards, decorators, exception filter, money/date/crypto utils
  modules/
    access/      roles → permissions → division scopes (AuthUser)
    auth/        register, login, refresh rotation, logout, email verification, password reset
    users/       profile, address book
    admin/       staff accounts, role grants, suspensions
    divisions/   the 9 business divisions (cached)
    catalog/     categories, products, variants, images (public + admin)
    inventory/   stock levels, ledger, atomic reserve/commit/release
    delivery/    zones & server-side delivery fees, delivery dispatch
    cart/        per-division carts priced live from the DB
    orders/      checkout, order lifecycle, expiry
    payments/    Paystack client, payment service, webhooks, refunds, reconciliation
    loyalty/     Green Wallet points (earn, reverse, adjust)
    apartments/  properties, units, availability, holds, reservations
    vehicles/    showroom listings, inquiries, deposit holds
    services/    generic bookable services (auto servicing, rentals, design consultations, ...)
    spa/         treatments, therapists, slot availability, appointments
    logistics/   dispatch requests, quotes, shipment tracking
    quotations/  request-for-quote flow for any division
    notifications/ in-app notifications + mail abstraction
    reports/     revenue / order / stock summaries
    audit/       append-only audit log + search
    jobs/        expiry & reconciliation (timers locally, Cloud Scheduler in cloud)
    health/      liveness / readiness
```

## 2. Money

All money is stored as `BIGINT` minor units (kobo) in columns named `*Minor`.
It is computed with `bigint` arithmetic only and serialised to JSON as an
integer. Clients never send prices. The server reads them from
`product_variants`, `apartment_units`, `spa_treatments` and similar tables,
and snapshots them on order or booking rows. Checkout also accepts an optional
`expectedTotalMinor`: if the server total differs, the request returns 409 and
the customer sees the changed price before paying.

## 3. Security model

| Concern | Implementation |
|---|---|
| Passwords | scrypt (N=2¹⁷, r=8, p=1), per-user salt, self-describing hash format |
| Access tokens | HS256 JWT, 15 min, carries only user id + session id |
| Refresh tokens | opaque 48-byte random, stored as SHA-256 hash, rotated on every use; replaying a rotated token revokes all of the user's sessions |
| Logout | revokes the session row, so the access token stops working on the next request |
| Brute force | per-IP rate limits (stricter on `/auth/*`), account lock for 15 min after 5 failures |
| Enumeration | identical responses for unknown email on login / forgot-password / resend |
| Email verification, reset | single-use SHA-256-hashed tokens with expiry; reset signs out every device |
| RBAC | global `AuthGuard` checks the token and `@RequirePermissions`; services check the division with `user.assertCan(permission, divisionId)` |
| Validation | global `ValidationPipe` (whitelist + forbid unknown fields) and DTOs |
| Errors | one exception filter; no SQL or stack traces reach clients; every response carries `x-request-id` |
| Audit | `audit_logs` records auth events, staff/admin changes, price changes, payments, refunds (secrets redacted) |
| Headers / CORS | helmet; CORS allow-list from `CORS_ORIGINS` |
| Secrets | environment / Secret Manager only; live Paystack keys and dev placeholders are refused at startup |

### Roles

| Role | Scope | Summary |
|---|---|---|
| Super Administrator | group | everything, including granting any role |
| Group Management | group | read everything, reports, audit, reconciliation, loyalty |
| Department Manager | one division | manage catalogue, stock, orders, bookings, refunds; grant Department Staff in that division |
| Department Staff | one division | daily operations: stock, orders, deliveries, bookings, inquiries |
| Customer Support | group | read customers, orders, bookings, payments; handle inquiries |
| Customer | own data | customer endpoints check ownership |

Role definitions live in `src/modules/access/permissions.ts`. The seed writes
them to the database, and the guard reads them from the database on each
request (10 s cache), so a role change takes effect within seconds.

## 4. Concurrency guarantees

* **Stock**: each reserve, commit or release is one conditional `UPDATE … WHERE on_hand - reserved >= q`. Row locks are taken in a fixed order, and a `CHECK (on_hand >= reserved >= 0)` constraint backs this up. Tested: 6 simultaneous checkouts for 3 units produce exactly 3 orders.
* **Apartments**: a PostgreSQL `EXCLUDE USING gist (unit_id WITH =, daterange(check_in, check_out) WITH &&)` constraint on active reservations (HOLD, CONFIRMED, CHECKED_IN) makes double booking impossible at the database level. Tested: 8 simultaneous requests for the same dates produce exactly 1 hold.
* **Spa**: the same kind of exclusion constraint on therapist time ranges.
* **Payments**: the move to SUCCESS is a conditional update. Fulfilment (order paid, stock committed, reservation confirmed, loyalty awarded) runs in that same transaction, so it happens exactly once even when verify, the webhook and reconciliation all run at the same moment.
* **Idempotency**: `Idempotency-Key` headers on checkout, reservation and payment initialisation are unique per user in the database.

## 5. Payment flow (all divisions)

```
client                       API                                   Paystack (test)
  │ POST /payments/initialize {purpose, payableId}                       │
  │──────────────────────────►│ handler.resolve() → server amount        │
  │                           │ create Payment (unique reference)        │
  │                           │──── POST /transaction/initialize ───────►│
  │◄── authorizationUrl ──────│                                          │
  │ ── customer pays on Paystack checkout ──────────────────────────────►│
  │ POST /payments/verify/:ref│──── GET /transaction/verify/:ref ───────►│
  │                           │ reference + amount + currency must match │
  │                           │ conditional → SUCCESS + handler.onPaymentSucceeded (same tx)
  │                           │◄─── webhook charge.success (HMAC-SHA512) │
  │                           │ store event once → re-verify via API → no-op if already SUCCESS
  Cloud Scheduler ──► /internal/jobs/reconcile-payments → verify open payments, refresh refunds
```

The `payments` table has a nullable foreign key per payable type. A CHECK
constraint requires exactly one of them to be set. Each module registers a
`PayableHandler` (`resolve` / `onPaymentSucceeded`) with the `PayableRegistry`,
so the payment code never needs to know business rules.

| Purpose | Payable | Amount | On success |
|---|---|---|---|
| ORDER | orders | order total | PAID, stock committed |
| APARTMENT_RESERVATION | reservations | stay total | HOLD → CONFIRMED |
| SPA_APPOINTMENT | spa_appointments | deposit | CONFIRMED |
| SERVICE_BOOKING | service_bookings | staff/fixed price | CONFIRMED |
| VEHICLE_DEPOSIT | vehicle_inquiries (approved DEPOSIT_HOLD) | vehicle deposit | vehicle RESERVED |
| LOGISTICS_REQUEST | logistics_requests | staff quote | CONFIRMED |
| QUOTATION | quotations (ACCEPTED) | quote total | recorded, notify |

**Late payments.** A customer may pay after an order or hold has expired. The
payment is still recorded. The system tries to re-reserve the stock or dates.
If that fails, the payment is flagged `refundStatus=PENDING` with a reason and
an audit entry, and the customer is told a refund is coming. Staff then issue
it with `POST /admin/payments/:id/refunds`.

**Refunds.** Staff create a refund (full or partial), which calls
`POST /refund` on Paystack. Final status arrives through `refund.*` webhooks or
reconciliation. `refundStatus` / `refundedMinor` are recomputed from the refund
rows, and loyalty points are reversed in proportion.

## 6. Water, Drinks & Wines order lifecycle

```
cart ─checkout→ PENDING_PAYMENT ─verified payment→ PAID → PROCESSING → OUT_FOR_DELIVERY → DELIVERED → COMPLETED
                     │                                └─ staff cancel (restock; refund is a separate staff action) → CANCELLED → REFUNDED
                     ├─ customer/staff cancel → CANCELLED (stock released)
                     └─ ORDER_PAYMENT_TTL_MINUTES elapsed → EXPIRED (stock released)
```

Delivery fees come from `delivery_zones`. A zone that names the city takes
priority over a state-wide zone, and an optional free-delivery threshold
applies. Delivery status updates drive the order status and notify the
customer.

## 7. Apartment booking lifecycle

```
quote (GET /apartments/units/:id/quote) → POST /apartments/reservations → HOLD (APARTMENT_HOLD_TTL_MINUTES)
HOLD ─verified payment→ CONFIRMED ─staff→ CHECKED_IN ─staff→ COMPLETED
HOLD ─guest/staff cancel→ CANCELLED;  HOLD ─timeout→ EXPIRED (dates freed)
CONFIRMED ─staff cancel→ CANCELLED (refund via payments admin)
```

Stays are half-open `[checkIn, checkOut)`, so back-to-back bookings are
allowed. The total is nightly rate × nights + cleaning fee + refundable
caution deposit. Blackouts block units for maintenance or owner use.

## 8. Decisions and open items for the business

* **Currency**: NGN only, as the technical plan assumes.
* **Loyalty rates** come from the architecture brief: Water 1 pt/₦100, Apartments 2, Automobiles 1.5, Spa 2. Other divisions earn nothing until rates are agreed. Points cannot be redeemed yet; the rules for that are still to be decided.
* **Paid cancellations and refund policy** (apartments, spa) are handled by staff for now. Automatic cancellation fees need business rules.
* **Fulfilment location**: each division has one default stock location. Choosing between several depots for one order is future work.
* **Email/SMS provider**: the mail transport is an abstraction. Only `console` (development) is built. SMS and push notifications are modelled but not connected.
* **Age-restricted products** (wines) are flagged (`isAgeRestricted`). An age-confirmation step at checkout or delivery still needs to be defined.
* **Opening hours** for the spa are 09:00–19:00 Africa/Lagos, a placeholder until real hours are given.
* **File uploads**: image URLs are stored. Direct upload to Google Cloud Storage via signed URLs is the next step.

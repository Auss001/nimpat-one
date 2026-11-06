# Nimpat One backend: project status

Updated 2026-11-06. Everything runs locally. Nothing is deployed, and DNS has not been touched.

## Confirmed working

| Area | How it was checked |
|---|---|
| Accounts, roles, per-division permissions | End-to-end tests; live check of all 174 operations |
| Catalogue, stock, cart, checkout, orders, delivery | End-to-end tests; dashboard in the browser |
| Paystack flow | End-to-end tests **against a local mock** |
| Direct bank transfer: instructions, notice, proof upload, finance confirmation, rejection | End-to-end tests; finance confirm and reconcile clicked through in the dashboard on the test database |
| Pay on delivery and pay at location: collection records, receipts, verification, reconciliation | End-to-end tests |
| Deposits, part payments, outstanding balances | End-to-end and unit tests |
| Disputes, reversals, separation of duties, append-only history | End-to-end tests |
| Booking confirmation rules: full payment, deposit, staff approval | End-to-end tests on apartments; deposit rule also on spa |
| Catalogue confirmation gate | End-to-end test |
| Apartment and spa double-booking prevention, concurrent stock | End-to-end tests |
| Dashboard in your reference style | Viewed in the browser; production build succeeds |
| Catalogue of 6 November and apartment locations | All 68 rows compared with the supplied file; end-to-end test of the location filter. The 25 product images are AI mockups, kept off sale until staff confirm each record. The dashboard's location tabs have not been viewed signed in |
| Apartment condition and single-room booking | End-to-end tests, including simultaneous bookings. Dashboard screens typechecked and built, but not yet viewed signed in |
| Docker image | Last built before the 6 November catalogue, location, condition and room changes, so it needs rebuilding. That build included the `multer` and `deepmerge-ts` overrides and was started and checked: database, photos, payment routes, writable upload folder, non-root user. The test suites run outside Docker, not inside the image |

## Test results

| Suite | Result |
|---|---|
| Unit | 12 passed |
| End-to-end (5 files) | 69 passed; 8 skipped (real Paystack, needs a key) |
| Paystack script, dry run on mock | 8 passed |
| Live route check | 174 operations, 0 failures |

Not automated: the dashboard has no test suite. New screens were checked by loading them and through the transfer confirm and reconcile flow. Forms for payment rules, bank accounts, locations, collection recording, reject, dispute, resolve and reverse have been typechecked but not clicked through. Their backend calls are covered by end-to-end tests.

## Load test (local only)

One API process and PostgreSQL in Docker on this development machine, with the test client on the same machine. Results depend on the machine; they are not a production capacity figure. Details: `docs/load-test-results.json`.

| Scenario | Concurrent | Per second | p50 | p95 | p99 | Server errors |
|---|---:|---:|---:|---:|---:|---:|
| Health, no database | 50 | 5,920 | 7 ms | 16 ms | 24 ms | 0 |
| Product catalogue | 50 | 377 | 128 ms | 168 ms | 192 ms | 0 |
| Signed-in profile | 50 | 721 | 68 ms | 90 ms | 107 ms | 0 |
| Add to cart + checkout | 16 | 84 cycles | 167 ms | 344 ms | 500 ms | 0 |

Stock stayed consistent after 1,266 checkouts. The catalogue list is the slowest read and the first candidate for caching.

## Source control

The first commit is on `main`. **No remote, so nothing has been pushed.** Secrets, dumps, uploads, private documents and builds are ignored, and tracked files were scanned for credentials. Test-only passwords for throwaway test users remain in `test/`.

## Remaining security concerns

1. **Real Paystack not exercised**, including real webhook delivery.
2. **No two-factor login for staff.** Finance and Super Administrator accounts should have it before go-live.
3. **Dashboard tokens are in browser `localStorage`**, so a script injection could steal them. Consider secure cookies before production.
4. **Proof uploads are on local disk** and not virus-scanned. File types are checked by content. Production needs a private bucket and scanning.
5. **Rate limits are per server instance**, so they weaken as Cloud Run scales. Production needs a shared store.
6. **A Super Administrator can edit a payment rule and bank account alone.** Changes are audited, but changing a receiving account should need a second approver.
7. **Payment rows can change status at database level.** Only events, audit entries and deletions are locked by triggers.
8. **Reversing a payment doesn't undo a confirmed order or booking.** Staff get a notification and must decide.
9. **Dependency overrides:** `npm audit --omit=dev` reports 0 vulnerabilities, using package overrides for `multer` and `deepmerge-ts`. Remove them when NestJS and Prisma ship the fixes in the versions used here. Development tools were not audited.

## Missing company data

See [DATA_AUDIT.md](DATA_AUDIT.md). Nothing can be sold or booked until staff confirm records, add stock, add therapists and add delivery zones.

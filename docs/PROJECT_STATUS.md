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
| Staff and manager access, overview homepage | End-to-end tests. Invite, set password, manager sign-in, limited menu, charts and hover were clicked through in the dashboard on the test database. Editing prices as a manager is covered by tests only |
| Photo tools | End-to-end tests. Upload, make main, remove, bulk upload and error messages were clicked through in the dashboard on the test database |
| Stock import, pharmacy approval, unpublished prices, service bookings | End-to-end tests. The pharmacy list, pharmacist review, stock, cars and bookings screens were clicked through on the test database with the full catalogue loaded |
| Bulk product actions, account deletion | End-to-end tests. Select all, show to customers and the pharmacy refusal were clicked through on the test database |
| Customer app (`app/`) | Typechecked and built. On the test database, at phone size: sign up, sign in, sign out, basket, checkout, address, order, bank transfer notice, apartment hold, spa booking, service request, car enquiry, bookings, and the refusal to delete an account with open bookings. Home and shop viewed at desktop size. Empty screens viewed on the real data. **Not yet done:** a Paystack test checkout, because no valid test key is set; receipt upload, email confirmation and password reset through the app; iOS and Android wrapping |
| Docker image | Built from the current code and started on the test database: database, bundled photos, photo upload and resizing on Linux, overview, non-root user. The test suites run outside Docker, not inside the image |

## Test results

| Suite | Result |
|---|---|
| Unit | 12 passed |
| End-to-end (9 files) | 124 passed; 8 skipped (real Paystack, needs a key) |
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
6. **Uploaded photos are on local disk.** Cloud Run wipes its disk on restart, so production must set `PHOTO_STORAGE_DIR` to a mounted bucket. Database backups do not include these files, so `uploads/public-photos` needs backing up too. Photos are public once uploaded.
7. **Invitation links are shown in the dashboard while email is not connected.** Anyone who gets a link within 72 hours can set up that account, so share links privately. They stop being shown once a real mail provider is connected.
8. **A Super Administrator can edit a payment rule and bank account alone.** Changes are audited, but changing a receiving account should need a second approver.
9. **Payment rows can change status at database level.** Only events, audit entries and deletions are locked by triggers.
10. **Reversing a payment doesn't undo a confirmed order or booking.** Staff get a notification and must decide.
11. **Dependency overrides:** `npm audit --omit=dev` reports 0 vulnerabilities, using package overrides for `multer` and `deepmerge-ts`. Remove them when NestJS and Prisma ship the fixes in the versions used here. Development tools were not audited.

## Before the mobile apps can use the API

- The API runs only on this computer. The apps need a public HTTPS address, so hosting on Google Cloud comes first.
- Paystack is in test mode, and emails and SMS only print to the server console.
- There are no push notifications yet.
- App stores restrict alcohol and medicines, so check their rules for these categories before submitting.

## Pharmacy limits

- A Super Administrator holds every permission, so can approve medicines without being a pharmacist. Each approval is recorded with who made it. Decide whether this should be limited to the Pharmacist role.
- Prescription-only and restricted medicines cannot be bought online. There is no prescription upload yet, so customers book a pharmacist instead.
- Medicines are set to pickup only until delivery rules are agreed.

## Missing company data

See [DATA_AUDIT.md](DATA_AUDIT.md). Nothing can be sold or booked until staff confirm records, add stock, add therapists and add delivery zones.

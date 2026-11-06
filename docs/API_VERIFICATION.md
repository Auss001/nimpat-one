# API verification report

Run on 2026-11-06 against the local development API and PostgreSQL 17 in Docker. Full route-by-route results: `docs/api-verification.json` (regenerate with `scripts/verify-api.ts`).

| Check | Result |
|---|---|
| API starts | Yes, including from the production build |
| PostgreSQL | `/health/ready` reports the database up |
| Migrations | 3 applied (`init`, `unit_bathrooms_decimal`, `payments_v2_and_record_verification`); no drift between schema and database |
| Swagger | UI and JSON both served; OpenAPI 3.0.0 |
| Routes | 174 operations (30 public, 91 staff) all respond |
| Without a token | Every protected route returns 401 |
| As a customer | Every staff route returns 403 |
| Server errors | None across all routes and roles |
| Department permissions | Tested end to end: staff of one division are refused for another (`test/app.e2e-spec.ts`, `test/payments-methods.e2e-spec.ts`) |
| CORS | `http://localhost:3000` and `:3001` allowed, with `Authorization`, `Content-Type`, `Idempotency-Key`. Unknown origins get no allow header |

## Limits of this check

- As admin, the script calls **GET routes only**, so it doesn't change data. Write routes as admin are covered by the end-to-end tests instead.
- Path parameters use random ids, so a 404 or 400 means "the route exists and rejected the input".
- Each run registers one throwaway customer (`verify.*@example.test`) in the database it runs against.

## Missing implementations behind documented endpoints

No documented endpoint is a stub. Features that are incomplete:

| Item | Current behaviour |
|---|---|
| Email | Only the `console` transport exists. Any other `MAIL_TRANSPORT` raises an error, by design |
| SMS and push | The channels exist in the data model, but nothing sends them |
| Spending loyalty points | Not built |
| Automated refunds for bank transfer or cash | Refused; finance pays out manually and records a reversal |
| Balance payment deadlines | See [NEXT_STEPS.md](NEXT_STEPS.md) |
| OpenAPI response schemas | Requests are described; response bodies are not |
| Real Paystack calls | Not yet run; see [PAYSTACK_TESTING.md](PAYSTACK_TESTING.md) |

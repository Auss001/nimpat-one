# Next steps

## Needed from you

1. **Paystack test keys**, to run `npm run test:paystack` ([PAYSTACK_TESTING.md](PAYSTACK_TESTING.md)).
2. **Permission to commit** the repository locally, and later a private remote to push to.
3. **Company data** ([DATA_AUDIT.md](DATA_AUDIT.md)): confirm catalogue records, stock counts, therapists, delivery zones, bank accounts, locations.
4. **Business decisions:**
   - Green Wallet: can points be spent, at what value, and what are the tiers?
   - Rates for the divisions without one.
   - Cancellation and refund rules for apartments and spa.
   - Deposit percentages and confirmation rule per department.
   - Whether dental services can be booked online.
   - Which email provider to use.

## Recommended next stage: connect the customer app

The backend is ready to connect to the existing customer app, once records are confirmed. Work through [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md) in this order:

1. Login, registration and profile.
2. Catalogue, cart and checkout, plus the Paystack return page.
3. Other payment methods.
4. Apartments.
5. Spa and vehicles.
6. Green Wallet history.

## Backend gaps to close

| Gap | Why it matters |
|---|---|
| **Balance deadlines** | Under `FULL_PAYMENT`, a hold with a verified deposit has no expiry, so it keeps the dates until staff act. There is no enforced due date for balances yet. The brief asks for payment deadlines. |
| Pay-on-delivery non-delivery | Accepted orders hold stock with no expiry; staff must cancel failed deliveries by hand |
| Manual refunds | Bank transfer and cash refunds aren't recorded as refunds, only as reversals |
| Real email provider | Verification and reset emails only print to the console |
| Cloud Storage | Catalogue photos and payment proofs are on local disk |
| Wishlist, loyalty redemption | The customer app shows them; the API doesn't support them |
| Per-room apartment pricing | Mentioned in the source data; not supported |
| OpenAPI response schemas | Would let generated clients type responses automatically |
| Automated dashboard tests | None exist yet |

## Before go-live

Do these only with your authorization: deploy to a staging environment, repeat the load test there, switch Paystack to live keys (this needs a code change, because live keys are refused), add staff two-factor login, and set up backups and monitoring. Customer-facing Android and iOS apps come after the web flows are proven, and they use this same API.

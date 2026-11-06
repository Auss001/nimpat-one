# Paystack test-mode status

**Real Paystack has not been called yet.** No test key has been provided. Everything below has passed against a local mock only.

## Run it

Get your test secret key from the Paystack dashboard (Settings → API Keys & Webhooks). Pass it as an environment variable; don't put it in a file that gets committed.

```bash
PAYSTACK_LIVE_TEST_KEY=sk_test_xxx npm run test:paystack
```

Keys that aren't `sk_test_…` are refused, and the key is never printed. `PAYSTACK_DRY_RUN=1 npm run test:paystack` runs the same steps against the mock.

## Coverage

| Scenario | Mock | Real test API |
|---|---|---|
| Initialization | Passed | In `test:paystack`, not run |
| Verification | Passed | In `test:paystack`, not run |
| Webhook authentication (bad signature refused) | Passed | Local check, in `test:paystack` |
| Signed but false webhook can't mark an order paid | Passed | In `test:paystack`, not run |
| Duplicate webhook delivery | Passed | In `test:paystack`, not run |
| Incorrect amount | Passed | **Mock only:** Paystack can't be made to return a wrong amount |
| Incorrect currency | Passed | **Mock only**, same reason |
| Interrupted payment | Passed | In `test:paystack`, not run |
| Failed payment | Passed | In `test:paystack`, not run |
| Order status updates | Passed | In `test:paystack`, not run |
| Refund and reconciliation | Passed | In `test:paystack`, not run |
| Real webhook delivery from Paystack | Not possible | **Manual**, see below |

## What may need adjusting on the first real run

- The script pays through Paystack's Charge API with its published test cards. If your account doesn't allow the Charge API, open the `authorizationUrl` and pay by hand on Paystack's test checkout.
- The declined-card number comes from my memory of Paystack's docs and hasn't been tried. If it succeeds, that test will fail; check Paystack's current test-card list.
- Refunds stay pending until Paystack processes them, so the script checks the request and reconciliation, not final completion.

## Real webhooks

Paystack must reach your computer. Expose the API with a tunnel, then set the test-mode webhook URL in the dashboard:

```text
https://<your-tunnel>/api/v1/payments/webhooks/paystack
```

Webhooks are signed with the secret key, so the API must run with the same key in `.env`.

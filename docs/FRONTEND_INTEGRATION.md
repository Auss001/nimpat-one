# Frontend integration guide

How the existing Nimpat One customer app (`nimpat-one/apps/web`, Next.js, port 3000) connects to this API. I read that app without changing it. Today it runs entirely on `src/lib/sample-data.ts` and `src/lib/store.tsx`, and it makes no API calls.

- **Base URL (local):** `http://localhost:4000/api/v1`. CORS already allows `http://localhost:3000`.
- **OpenAPI:** `docs/openapi/nimpat-one-api.v1.json`, or browse `/api/docs`.
- **Typed client:** `clients/typescript/` (`createNimpatClient`).
- **Real responses:** `docs/api-samples.json`, written by `test/contract.e2e-spec.ts`. Arrays in that file are shortened to two items.

## Conventions

| Topic | Rule |
|---|---|
| Money | Whole kobo in `…Minor` fields: `150000` = ₦1,500.00. Never send prices to the API. |
| Auth | `Authorization: Bearer <accessToken>`. The token lasts 15 minutes. On 401, call `POST /auth/refresh` once with the refresh token. It returns a new pair, and the old refresh token stops working. |
| Lists | `{ data: [...], meta: { page, pageSize, total, totalPages } }`, with `?page=&pageSize=` (maximum 100). |
| Retries | Send an `Idempotency-Key` header (8–100 characters) on `POST /orders`, `/apartments/reservations`, `/payments/initialize` and `/payments/bank-transfer`. |
| Dates | Stays use `YYYY-MM-DD`. Timestamps are UTC ISO-8601. The business timezone is Africa/Lagos. |
| Images | Paths such as `/media/assets/x.jpg` are relative to the API origin, not `/api/v1`. |
| Visibility | Customer endpoints return only records the company has confirmed. **The catalogue will look empty until staff confirm records** under Data confirmation in the dashboard. |

### Errors

Every error has the same shape:

```json
{ "statusCode": 409, "error": "Conflict", "message": "Only 497 available", "requestId": "c9cc…" }
```

`message` is an array of strings on validation errors (400).

| Status | Meaning | What the app should do |
|---|---|---|
| 400 | Invalid input or a rule was broken | Show `message` |
| 401 | Missing or expired token | Refresh once, then send to login |
| 403 | Not allowed, or email not verified before payment | Show `message` |
| 404 | Not found, not yours, or not confirmed for sale | Show "not available" |
| 409 | Out of stock, dates taken, price changed, already processed | Reload and show `message` |
| 422 | No delivery to that location | Offer pickup or another address |
| 429 | Too many requests (120 per minute per route; 10 on login routes) | Wait and retry |
| 502 | Paystack unreachable | Retry |

## Screen-by-screen map

Replace each store action on the left with the API call on the right. 🔒 means a token is required.

### Products (`/categories/[slug]`, `/shop/products/[slug]`)

| Interaction | Call | Request | Response |
|---|---|---|---|
| Category hubs | `GET /divisions` | none | `[{ id, code, name, slug, kind, description }]` |
| Product categories | `GET /catalog/categories?division=water-drinks-wines` | none | `[{ id, name, slug, description, parentId, sortOrder }]` |
| Product listing and search | `GET /catalog/products?division=&category=&q=&page=&pageSize=` | none | Page of products with `priceFromMinor`, `inStock`, `images[]`, `category`, `variants[]` |
| Product details | `GET /catalog/products/:slug` | none | Product with `variants[]`: `{ id, sku, name, unitPriceMinor, compareAtPriceMinor, availableQuantity, minOrderQty, maxOrderQty }` |
| Live stock | `GET /catalog/availability?variantIds=a,b` | none | `[{ variantId, sku, availableQuantity }]` |

### Cart (`addToCart`, `updateQuantity`, `removeFromCart`, `clearCart`)

Carts are per division and live on the server. They need a signed-in customer.

| Interaction | Call | Request | Response |
|---|---|---|---|
| Add 🔒 | `POST /carts/items` | `{ variantId, quantity }` | Cart: `{ lines[], itemCount, subtotalMinor, canCheckout }` |
| Change quantity 🔒 | `PATCH /carts/items/:variantId` | `{ quantity }` (0 removes) | Cart |
| Remove 🔒 | `DELETE /carts/items/:variantId` | none | Cart |
| View 🔒 | `GET /carts/:division` | none | Cart. Each line has `issues[]`: `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `UNAVAILABLE`, `BELOW_MIN_QTY`, `ABOVE_MAX_QTY` |
| Empty 🔒 | `DELETE /carts/:division` | none | Cart |

### Checkout (`handleCheckout` in `global-drawers.tsx`, which today only shows a toast)

1. **Totals:** `GET /carts/:division/quote?fulfilmentType=DELIVERY&addressId=` 🔒 returns the cart plus `deliveryFeeMinor`, `delivery`, `totalMinor`.
2. **Which payment options to show:** `GET /orders/checkout-options?division=&fulfilmentType=&addressId=` 🔒 returns `{ orderValueMinor, options: [{ option, available, reason? }] }`. Options are `PAYSTACK`, `BANK_TRANSFER`, `PAY_ON_DELIVERY`, `PAY_AT_LOCATION`. Show each one's `reason` when it's unavailable.
3. **Place the order:** `POST /orders` 🔒 with an `Idempotency-Key`:
   ```json
   { "division": "water-drinks-wines", "fulfilmentType": "DELIVERY", "addressId": "…",
     "paymentOption": "PAYSTACK", "expectedTotalMinor": 450000, "customerNote": "optional" }
   ```
   If the total changed, you get 409 with `totalMinor`. Show the new price. The response is the order.
4. **Pay** according to the option chosen (next section).

### Payment

Before an order exists, `GET /payments/methods?division=&purpose=ORDER` is public and tells you how a division accepts payment. For an existing order or booking, `GET /payments/options?purpose=&payableId=` 🔒 returns methods, deposit, paid, outstanding and service locations. `purpose` is one of `ORDER`, `APARTMENT_RESERVATION`, `SPA_APPOINTMENT`, `SERVICE_BOOKING`, `VEHICLE_DEPOSIT`, `LOGISTICS_REQUEST`, `QUOTATION`.

**Paystack (card, Paystack bank transfer, USSD)**

1. `POST /payments/initialize` 🔒 `{ purpose, payableId, amountOption? }`. `amountOption` is `BALANCE` (default) or `DEPOSIT`. The response is `{ paymentId, reference, amountMinor, authorizationUrl, accessCode, publicKey, reused }`.
2. Redirect to `authorizationUrl`, or open Paystack Popup with `accessCode`.
3. On return, call `POST /payments/verify/:reference` 🔒. Show paid only when the returned `status` is `SUCCESS`. Never trust the redirect alone.

**Direct bank transfer**

1. `POST /payments/bank-transfer` 🔒 `{ purpose, payableId, amountOption? }` returns `{ reference, amountMinor, payBy, account: { bankName, accountName, accountNumber }, narration, steps[] }`.
2. "I have paid": `POST /payments/bank-transfer/:reference/notify` 🔒 `{ payerName, transferredAt?, amountMinor?, customerReference? }`.
3. Optional receipt: `POST /payments/bank-transfer/:reference/proofs` 🔒, multipart field `file` (PNG, JPEG or PDF, 5 MB maximum, 3 files maximum).
4. Show "awaiting verification". The order changes only after finance confirms the money.

**Pay on delivery / pay at location**

Choose the option at checkout. The order comes back `ACCEPTED` and `UNPAID`, with nothing further for the customer to do. Staff record the collection and finance verifies it. Show receipts with `GET /payments/receipts/:reference` 🔒.

**Showing status**

Show the order status and payment status separately, never as one value. `GET /payments/summary?purpose=&payableId=` 🔒 returns `totalDueMinor`, `depositRequiredMinor`, `paidMinor`, `awaitingVerificationMinor`, `outstandingMinor`, `paymentStatus` and `payments[]`. My payments: `GET /payments` 🔒.

| Field | Values |
|---|---|
| Order `status` | `PENDING`, `ACCEPTED`, `PROCESSING`, `READY`, `OUT_FOR_DELIVERY`, `DELIVERED`, `COMPLETED`, `CANCELLED`, `EXPIRED` |
| `paymentStatus` | `UNPAID`, `AWAITING_VERIFICATION`, `PARTIALLY_PAID`, `PAID`, `REFUNDED`, `FAILED` |
| Payment `status` | `INITIALIZED`, `PENDING`, `AWAITING_VERIFICATION`, `SUCCESS`, `FAILED`, `ABANDONED`, `REVERSED`, `REJECTED` |
| `reconciliationStatus` (finance) | `NOT_COLLECTED`, `COLLECTION_REPORTED`, `COLLECTION_VERIFIED`, `RECONCILED`, `DISPUTED` |

### Registration, login, profile (`/account/*`)

| Interaction | Call | Request | Response |
|---|---|---|---|
| Register | `POST /auth/register` | `{ email, password, firstName, lastName, phone?, marketingOptIn? }` | `{ user, accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresAt, tokenType }` |
| Login | `POST /auth/login` | `{ email, password }` | Same as register |
| Verify email | `POST /auth/verify-email` | `{ token }` from the email link (`/verify-email?token=`) | `{ ok: true }` |
| Resend verification | `POST /auth/resend-verification` | `{ email }` | `{ ok: true }` |
| Forgot / reset password | `POST /auth/forgot-password`, `POST /auth/reset-password` | `{ email }`, `{ token, newPassword }` | `{ ok: true }` |
| Change password 🔒 | `POST /auth/change-password` | `{ currentPassword, newPassword }` | `{ ok: true }` |
| Current user 🔒 | `GET /auth/me` | none | User, `customerProfile`, `loyalty`, `roles`, `permissions` |
| Update profile 🔒 | `PATCH /me/profile` | `{ firstName?, lastName?, phone?, dateOfBirth?, marketingOptIn? }` | Profile |
| Addresses 🔒 | `GET`/`POST /me/addresses`, `PATCH`/`DELETE /me/addresses/:id` | `{ recipientName, phone, line1, city, state, label?, line2?, landmark?, lga?, isDefault? }` | Address(es) |
| Logout 🔒 | `POST /auth/logout`, `POST /auth/logout-all` | none | `{ ok: true }` |

Passwords need 10–128 characters with a letter and a number. Phones must be Nigerian `+234…`. **Payment needs a verified email** (403 otherwise).

### Order history (`/account/orders`)

`GET /orders?status=&division=&page=` 🔒, `GET /orders/:id` 🔒 (adds `statusHistory`, `delivery`, `payments`), `POST /orders/:id/cancel` 🔒 (unpaid pending orders only).

### Apartments (`/apartments`, `/apartments/[id]`, `/account/bookings`)

| Interaction | Call | Request / query | Response |
|---|---|---|---|
| Listing | `GET /apartments/properties` | `city, checkIn, checkOut, guests` | Page of `{ id, name, slug, city, state, amenities, image, unitCount, availableUnitCount, nightlyFromMinor }` |
| Details | `GET /apartments/properties/:slug` | none | Property with `images[]`, `units[]` |
| Availability | `GET /apartments/units/:unitId/calendar?from=&to=` | none | `{ unavailable: [{ start, end, type }] }` (end is the checkout day) |
| Price | `GET /apartments/units/:unitId/quote?checkIn=&checkOut=&guests=` | none | `{ nights, nightlyRateMinor, accommodationMinor, cleaningFeeMinor, cautionDepositMinor, totalMinor, available }` |
| Reserve 🔒 | `POST /apartments/reservations` | `{ unitId, checkIn, checkOut, guests, guestNote? }` | Reservation: `status: HOLD`, `holdExpiresAt`, `depositRequiredMinor`, `totalMinor` |
| Pay 🔒 | Payment section, `purpose: APARTMENT_RESERVATION` | | The department's rule decides when it becomes `CONFIRMED` |
| Mine 🔒 | `GET /apartments/reservations`, `GET /apartments/reservations/:id` | | |
| Cancel a hold 🔒 | `POST /apartments/reservations/:id/cancel` | `{ reason? }` | |

Holds last 15 minutes. If two guests reserve the same dates, the loser gets 409: show "dates just taken".

### Vehicles (`/automobiles/[id]`)

| Interaction | Call | Request / query |
|---|---|---|
| Listing | `GET /vehicles` | `make, model, condition, minYear, maxPriceMinor, page` |
| Details | `GET /vehicles/:slug` | Returns `vinLast6`, never the full VIN |
| Inquiry 🔒 | `POST /vehicles/:id/inquiries` | `{ type, contactName, contactEmail, contactPhone, message?, preferredDate? }`. `type` is `GENERAL`, `TEST_DRIVE`, `INSPECTION`, `DEPOSIT_HOLD` or `FINANCING` |
| My inquiries 🔒 | `GET /vehicles/inquiries/mine` | |
| Pay a deposit 🔒 | Payment section, `purpose: VEHICLE_DEPOSIT`, `payableId` = inquiry id | Only after the showroom approves a `DEPOSIT_HOLD` |

### Spa (`/spa/[id]`)

| Interaction | Call | Request / query |
|---|---|---|
| Menu | `GET /spa/treatments` | |
| Details | `GET /spa/treatments/:slug` | Includes `practitioners[]` |
| Free times | `GET /spa/treatments/:id/slots?date=YYYY-MM-DD&practitionerId=` | `{ slots: [{ startsAt, endsAt, practitionerIds }] }` |
| Book 🔒 | `POST /spa/appointments` | `{ treatmentId, startsAt, practitionerId?, customerNote? }`. Returns `status: PENDING` with `payBy` when a deposit applies, otherwise `REQUESTED` |
| Pay deposit 🔒 | Payment section, `purpose: SPA_APPOINTMENT` | |
| Mine, cancel 🔒 | `GET /spa/appointments`, `POST /spa/appointments/:id/cancel` | |

### Green Wallet (`/account/wallet`)

`GET /loyalty/me` 🔒 returns `{ account: { pointsBalance, lifetimeEarned, tier }, history: Page<{ type, points, balanceAfter, description, division, createdAt }> }`. `GET /loyalty/rules` returns earning rates. Points come only from verified payments. Notifications: `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` 🔒.

## Where the app and API differ

These need changes in the customer app, or a decision.

| Customer app today | API | Action |
|---|---|---|
| `product.priceMinor`, `stockQuantity`, `unitLabel` | `variants[].unitPriceMinor`, `.availableQuantity`, `.name` (`priceFromMinor` on lists) | Map per variant |
| `addToCart(product)` uses a product id | Cart uses `variantId` | Use the chosen variant |
| One cart in the browser, guests allowed | One server cart per division, sign-in required | **Decision:** keep a browser cart until login, then send it to the API |
| `imageUrl: /assets/…` | `images[].url: /media/…` on the API origin | Prefix with the API URL (`client.mediaUrl`) |
| Product `category` enum | `category: { name, slug }` from the database | Filter by slug |
| Spa `title`, category enum | `name`, `category` text ("Facials") | Rename, map labels |
| Routes use sample ids (`/spa/[id]`, `/apartments/[id]`, `/automobiles/[id]`) | Details are fetched by slug | Route by slug |
| Apartment list per unit: `pricePerNightMinor`, `cautionFeeMinor`, `featuredImages`, amenity objects | Property with units: `nightlyRateMinor`, `cautionDepositMinor`, `images[]`, amenity text on the property | Flatten `units[]` or list properties |
| Vehicle `colorExterior`, `colorInterior`, `features`, `location` | `colour`, `specs.interior`, `specs.features`, `specs.location` | Map |
| Register `fullName` | `firstName`, `lastName` | Split the field |
| Profile free-text `address` | Structured address book | Use address forms |
| `/categories/real-estate-interior` | Accepted as an alias of `real-estate-interior-design` | No change needed |
| Wishlist drawer | **No API yet** | Keep in the browser, or ask me to add it |
| Green Wallet: 1 point = ₦1, vouchers, `redeemVoucher` | **Spending points is not built.** Docs also say the wallet is not stored value | **Business decision needed.** Hide redemption until then |
| Tiers `GREEN_EXPLORER` etc. | `tier: "GREEN"` only | Tier rules needed |
| Entertainment, rentals, real estate samples | `GET /services?division=`, booked with `POST /services/bookings` | Map to offerings |
| Retail supplies | Same catalogue API with `division=retail-general-supplies` | |
| Logistics sample tracker | `GET /logistics/track/:number` | Sample number will not exist |

## Local setup for the frontend

```bash
docker compose up -d db
```

```bash
npm start
```

Set the app's API base URL to `http://localhost:4000`. In development, verification and password-reset links are printed in the API console. The Paystack redirect comes back to `PAYSTACK_CALLBACK_URL` (`http://localhost:3000/payments/callback`), a page the app still needs.

## Unpublished prices and availability

- `unitPriceMinor` and `priceFromMinor` may be `null`, which means the price is not published. Show "Contact for price" or hide it. Never show ₦0. `pricePublished` says whether any size has a price.
- Use `inStock` for availability, because a product may be listed as in stock without a live count.
- Each variant has `purchasable` and `purchaseNote`. When `purchasable` is false, hide Add to Cart and show the note.
- `imageStatus` is `AVAILABLE` or `IMAGE_PENDING`. Show "Image pending" for the second, and never a similar product's photo.

## Pharmacy, laboratory and spa bookings

- Pharmacy products use the division `pharmacy-laboratory`, and appear only after pharmacist approval and company confirmation. Show medical information for general reference only, without diagnosis or dosage advice.
- List pharmacy and laboratory services with `GET /services?division=pharmacy-laboratory`, and book with `POST /services/bookings`. Put what the customer asked for in `details`, such as `{ "requestedTest": "..." }`. Staff then confirm the time and price.
- Spa bookings use `GET /spa/treatments`, `GET /spa/treatments/:id/slots` and `POST /spa/appointments`. They need at least one active therapist and confirmed treatments.

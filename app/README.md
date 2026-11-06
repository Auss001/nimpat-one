# Nimpat One customer app

The app customers use: shop, pharmacy, apartments, cars, spa, services, basket, payment, bookings and account. It is a web app built mobile first, so it can be wrapped for the App Store and Google Play with Capacitor without being rewritten.

## Run it

Start the API on port 4000, then:

```bash
npm install
npm run dev
```

It opens on http://localhost:3002 and sends `/api` and `/media` to the API.

## Rules the screens follow

- No price means "Contact for price", never ₦0.
- No photo means "Image pending", never a similar photo.
- The API decides what can be bought. The app only shows Add when `purchasable` is true.
- Medicines that need a prescription cannot be bought online. The customer is sent to book a pharmacist.
- Alcohol asks the customer to confirm they are 18 or older.
- A bank transfer is confirmed only when Nimpat finance has checked the money. "I have paid" and an uploaded receipt never confirm it.
- A Paystack payment counts only after the API has checked it with Paystack.

## Build

`npm run build` writes the site to `dist/`. In production, set these on the API to the app's public address: `APP_PUBLIC_URL`, `PAYSTACK_CALLBACK_URL` and `CORS_ORIGINS`.

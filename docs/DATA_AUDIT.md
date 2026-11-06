# Catalogue data audit

Taken from the development database on 2026-11-06. For live figures, use **Data confirmation** in the dashboard or `GET /admin/records/audit`.

**Source of the data:** `nimpat-one/apps/web/src/lib/sample-data.ts`, which you described as gathered from the departments. Nobody has formally confirmed it, so I did not mark any of it as verified.

| Records | Verified real | Awaiting company confirmation | Development samples (switched off) |
|---|---:|---:|---:|
| Products | 0 | 67 | 4 |
| Apartment units | 0 | 11 | 2 |
| Vehicles | 0 | 2 | 1 |
| Spa treatments | 0 | 57 | 1 |
| Rentals, property, entertainment | 0 | 9 | 1 |
| Delivery zones | 0 | 0 | 2 |

**Sales are blocked until records are confirmed.** Unconfirmed records don't appear on customer endpoints, can't be added to a cart, checked out or booked, and unconfirmed delivery zones are never charged. Samples can never be confirmed. Staff with `records:verify` (Super Administrator, Department Manager of that division) confirm records under Data confirmation, and each confirmation records who did it and when.

Because no delivery zone is confirmed, **delivery checkout returns an error for every address** until you add real zones.

## Missing data

| Item | Status | Who can supply it |
|---|---|---|
| Product prices | All 67 have a price, but prices are unconfirmed | Department heads |
| Actual stock | **All 67 are at 0.** The source showed exactly 100 for every item, which looks like a placeholder, so I didn't import it | Stores |
| Pack sizes | CWAY 50cl and Venida 50cl set to packs of 20 from your explanation and the prices; **please check the others**, such as Nestlé 60cl | Water, Drinks & Wines |
| Apartment availability | Comes from reservations and blocked dates; no existing bookings or owner calendar were supplied | Apartments |
| Per-room pricing | The source mentions ₦80k per room for Mabushi and AJ Turner; only whole-unit booking exists | Apartments |
| Vehicle availability | Marked available in the source; needs showroom confirmation | Automobiles |
| Vehicle deposits | Not set on either vehicle, so deposit holds are off | Automobiles |
| Spa staff and schedules | **No therapists, so no appointments can be booked.** Hours are a placeholder (09:00–19:00), and rosters don't exist | Spa |
| Delivery fees | Only the 2 samples exist, and they're never charged | Water, Drinks & Wines |
| Pickup and service locations | None | Each department |
| Receiving bank accounts | None, so direct transfer is unavailable | Finance |
| Retail photographs | 3 products have none; the source files don't exist | Retail |
| Spa photographs | The data model holds no treatment images | Spa |
| Rentals, property, entertainment photographs | The data model holds no images for these listings | Each department |
| Stock photos | Some images in the source project are Pexels stock or generic. Replace any that imply they show a real Nimpat property or product | Marketing |
| Dental services | The project docs say clinical services need approval. Please confirm before enabling them | Management |
| Entertainment listings | Names and prices came from sample data. Please confirm they are real | Entertainment |

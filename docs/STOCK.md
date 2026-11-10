# Stock, lists and what customers can buy

How Nimpat One decides whether customers can order an item, and what the spreadsheets we receive are used for. Agreed with the owner on 10 November 2026.

## The one rule: each product's Availability setting

Every product has an **Availability** setting. You'll find it in the dashboard under **Products → edit a product**.

| Setting | What customers see | Can they order it? | Is stock counted? |
|---|---|---|---|
| **In stock (always available)** | "In stock" | Yes, always | No. No count is needed, and none is changed. |
| **Out of stock** | "Out of stock" | No | No |
| **Use the stock count** | "In stock" while the count is above 0 | Only while the count allows | Yes. Orders hold and then use up units. Two customers can never both take the last one. |

This setting is the only thing that decides availability:
- The product page, the basket and checkout all follow it.
- The dashboard's **In stock** column shows the same thing in words.

Before 10 November, the basket used the count even when a product was set to "In stock". So items with a count of 0, such as Swan 50cl and CWAY 50cl, showed "In stock" on the product page but "Out of stock" in the basket. That is fixed.

**Which to choose:**
- **In stock:** for everyday items you keep on the shelf and don't count item by item. Most water and drinks are like this.
- **Use the stock count:** only for items you really count and update in **Stock**, for example expensive spirits.
- **Out of stock:** when something has run out. Switch it back when it's in again.

**Hide out-of-stock items:** each shop's Products page has this switch. When it's on, items set to Out of stock, and counted items at 0, are hidden from the shop lists. A saved link still opens the item, marked out of stock.

## Lists and spreadsheets are a guide

The lists we receive (price lists, stock lists, the car stand records) are **guidance, not instructions**. Nothing is applied just because it is in a list.

- **Price lists** (Products → Upload price list):
  - You see a preview first and choose which rows to apply.
  - Rows that look wrong are left unticked: cost above the selling price, a price jump of more than 50%, or an uncertain name match.
  - Only selling prices go live. Cost prices are used only to spot mistakes, and customers never see them.
  - Quantities are kept as a dated note ("list said 12 on 10 Nov, guide only"). They never change Availability.
- **New items in a list:**
  - Pharmacy items arrive awaiting the pharmacist and can't be bought until approved.
  - Other new items arrive as drafts for staff to check and publish.
- **Car stand records:**
  - The manager's sheet (`records updated 1.2.xlsx`) was used to match photos to cars and to spot sold cars.
  - Details we could not confirm are written up in `store-assets/car-photos/CARS-FROM-CHAT.md` for you to decide.
  - Examples: the Passport/Pilot name, mismatched years, and a ₦1,300,000 C300 that looks like a missing zero.

## Car photos and details

- **Photos:** Automobiles → Upload photos & details. Drag the files in, or choose them.
  - Name each file `<car web address>-01.jpg`, `-02.jpg`…
  - `01` becomes the main photo and replaces the car's old photos.
- **Details:** a sheet with a **Web address** column fills trim, body type, transmission, fuel, colour and description.
  - Any other column (Engine, Drive, Seats…) shows on the car page as a feature.
  - Empty cells change nothing.
  - The specs we added are published figures for each model and year. Each description asks customers to confirm trim, mileage and papers.
- **One car's photos:** open its Photos and drag pictures straight in.

## Delivery fees

Abuja delivery is set in rings around Nimpat in Wuye, by the button on the **Delivery** page:

| Ring | Fee |
|---|---|
| Wuye and Utako | Free |
| Central areas | ₦5,000 |
| Middle ring | ₦7,500 |
| Gwarinpa, Kubwa and the far edges | ₦10,000 |
| Abuja areas not on the list | ₦10,000 |

Each ring is an ordinary delivery zone, so you can edit its fee or areas on that page. The area list lives in `src/modules/delivery/abuja-areas.ts`.

## For developers

| Rule | Where it's implemented |
|---|---|
| Stock (reserve, commit, release, restock) | `src/modules/inventory/inventory.service.ts`. Only lines a given order actually reserved or sold are moved on. Changing a product's setting mid-order can't break a payment or a cancellation. |
| Basket stock check | `src/modules/cart/cart.service.ts`. It checks the count only for "Use the stock count" items. |
| Customer-facing `inStock` and `purchasable` | `publicProduct` in `src/modules/catalog/catalog.service.ts` |

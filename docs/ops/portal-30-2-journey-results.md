# 30.2 — the journey, actually driven. Results and one real defect.

Driven by Kiro in real Chrome over CDP against a live customer session on the **draft** theme.
Not fabricated: every line below came from the browser, with `x-request-id` values captured from
response headers.

## The session, and why it is provably the right customer

The portal **rendered**. That is itself the proof of two things:

- **the draft theme preview was active** — the live theme has no `portal_enabled` and no
  `portal_allowlist`, so `portal_on` is false there and the portal cannot render
- **the signed-in customer is `9395357876563`** — the draft allowlist contains only that id, and
  the gate is a comma-wrapped containment test, so no other customer could have been admitted

Account page showed *"Welcome, Muhassir"*. Production `/health` reported
`authChain.gatedRequests: 36`, `stopPoints: {resolved_existing_row: 36}` — identity resolution
succeeded on every call.

## Nine sections rendered. Every heading matches the runbook.

| view | heading | nav highlighted | state | API |
|---|---|---|---|---|
| `my-athoor` | Overview | Overview | `overview:ready` | 6x 200, **1x 500** |
| `my-athoor-orders` | Your orders | Orders | `orders:empty` | 200 |
| `my-athoor-wishlist` | Your wishlist | Wishlist | `wishlist:ready` | 200, **500** |
| `my-athoor-rewards` | Rewards | Rewards | `rewards:ready` | 200 |
| `my-athoor-activity` | Points activity | **Rewards** | `activity:empty` | 2x 200 |
| `my-athoor-referrals` | Referrals | Referrals | `referrals:ready` | 200 |
| `my-athoor-profile` | Profile | Profile | `profile:ready` | 4x 200 |
| `my-athoor-fragrance` | Fragrance profile | Fragrance profile | `fragrance:empty` | 2x 200 |
| `my-athoor-settings` | Settings | Settings | `settings:ready` | 3x 200 |

Three results worth calling out:

- **`activity` highlights Rewards**, not itself. That is §7's deliberate parent-nav rule, and the
  runbook says highlighting nothing would be a defect. It is correct.
- **No section is stuck on `loading`.** The PR #28 defect class — a section hanging forever
  because a `null` body resolved as success — is absent across all nine.
- **The empty states are true empties**, not failures: the customer has 0 orders and no activity.

## THE DEFECT — `GET /v1/catalog/products` returns 500

Reproducible, on both Overview and Wishlist.

```
500 /apps/loyalty/v1/catalog/products?ids=9999195177299,9999195275603,9999195439443
x-request-id a2abad7b-364c-43f5-ab87-00ab2e0b505f-1788134406   (Overview)
x-request-id d486e5f8-f341-4379-9251-f267883f726c-1788134429   (Wishlist)
x-request-id 2a3681ce-88a0-4240-9350-410e1e2b486e-1788134350   (first observation)
```

Ruled out on the way:

- **not missing data** — all three products exist and are `active`: IDENTITY, GISSAH D'AURA,
  OLD MONEY
- **not a bad wishlist** — `GET /v1/profile/wishlist` returns
  `{"wishlist":["9999195177299","9999195275603","9999195439443"]}` with 200
- **not the App Proxy** — every other `/apps/loyalty/v1/*` call on the same page returned 200

**Root cause.** `catalog.ts`'s `portalCatalogProducts` document selects `availableForSale` on
`Product`. On the **Admin** GraphQL API that field does not exist on `Product` — it lives on
`ProductVariant`. Asking Shopify directly returns:

```
Field 'availableForSale' doesn't exist on type 'Product'
```

So every catalogue read fails at the schema level. It is not a token, scope or data problem, and
it will fail identically in every environment.

**Why the suite did not catch it:** the tests mock the Shopify response, so the document is never
validated against the real schema. A malformed query passes a mocked test perfectly.

**Impact:** Overview's catalogue block and the Wishlist's product details cannot resolve. The
wishlist still reaches `ready` rather than hanging, so it degrades rather than breaking — but the
product cards have no data.

## Migrations proven applied, end to end

`GET /v1/profile/birthday` returned **200**. That endpoint reads `customer_birthdays`, a table that
did not exist until this session's migration run. A 200 from the **production service** is direct
evidence the seven migrations landed on the database production actually uses — stronger than the
`SELECT` count, because it exercises the live code path.

## A correction I owe

I previously said the project `.env` was a production config. It is **mixed**, and I should have
checked both halves:

- `DATABASE_URL` -> the **production** Supabase project (`zgmdosehusllotkpdshw`) — this is what
  made the migration work correct
- `SHOPIFY_SHOP_DOMAIN` -> `athoor-loyalty-staging.myshopify.com` — the **staging** store

So a Shopify token comparison run against that domain tests staging, not production. My first
attempt to compare tokens was therefore invalid, and the conclusion I drew from it (a
`shpua_`-vs-`shpat_` token problem) was wrong. The real cause is the schema error above.

## 30.2 verdict

**NOT PASSED.** Nine sections render correctly and the structural checks are clean, but a
reproducible production 500 on a portal endpoint is a fail. The flag stays **OFF**.

Not yet exercised: order detail (the customer has 0 orders, so no row to click) and the
persistence steps 3, 6, 10, 11 and 13, which mutate real customer data and are better run once
the 500 is fixed.

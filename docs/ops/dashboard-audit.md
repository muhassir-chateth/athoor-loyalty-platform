# Storefront Loyalty Dashboard — Audit (spec task 27)

Date of run: 2026-07-26 (all live evidence captured in a single session).
Service audited: `https://athoor-loyalty-platform.onrender.com` (deployed Loyalty_Service).
Store audited: `athoor-loyalty-staging.myshopify.com` (**staging only** — production
`myathoorlondon.myshopify.com` was not contacted, not even read-only).
Theme code audited: this repository's `theme/` directory.

Customers are referenced by Shopify customer id only.

**Read this section first.** This document deliberately separates two very different
claims:

- **LIVE** — I issued the request/query and am reporting the response. This is verified.
- **STATIC** — I read the source and reasoned about it. This is *not* verified against a
  running page. No rendered browser test, no screen reader, no real device was used.

Task 27 is **not complete**. The Lighthouse performance/accessibility scores it asks for
do **not** exist yet, and nothing in this document should be read as "Lighthouse is
probably fine". See §2 and §4.

---

## 1. What WAS verified (live)

### 1.1 App Proxy transport and auth (LIVE)

All calls went to the deployed service with a Shopify-style App Proxy signature (HMAC-SHA256
over the query parameters excluding `signature`, sorted by key, `key=value` concatenated
with no separator, keyed by the app secret). Every request below is a `GET`; no
state-changing endpoint was called.

| Probe | Result |
| --- | --- |
| Valid signature, known customer | `200` on `/v1/balance`, `/v1/history`, `/v1/rewards`, `/v1/referral`, `/v1/profile`, `/v1/profile/journey`, `/v1/version` |
| Tampered `signature` | `401 {"error":"app_proxy_signature_invalid","message":"...logged_in_customer_id was ignored."}` |
| Valid signature, unknown `logged_in_customer_id` (`9999999999999`) | `401 {"error":"identity_resolution_failed"}` |

The signature gate fails closed and the identity is taken from Shopify's injected
`logged_in_customer_id`, not from anything client-controlled. Verified, not assumed.

### 1.2 `GET /v1/balance` (LIVE, cross-checked against the ledger)

| Field | Customer `9037455327431` | Customer `9037455425735` |
| --- | --- | --- |
| `spendableBalance` | `250` | `500` |
| `tier` | `bronze` | `silver` |
| `tierMultiplier` | `1` | `1.5` |
| `lifetimeSpendGBP` | `0` | `350` |
| `isTopTier` | `false` | `false` |
| `nextTier` / `nextTierThresholdGBP` | `silver` / `300` | `gold` / `750` |
| `progressToNextTierGBP` | `300` | `400` |
| `availableRewards` | 4 rewards (100/250/500/1000) | 4 rewards (100/250/500/1000) |

Database cross-check (read-only `BEGIN READ ONLY` transaction against the live Supabase
Postgres, using the same definitions as `loyalty-service/src/ledger/balance.ts`):

| Definition | Customer `9037455327431` | Customer `9037455425735` |
| --- | --- | --- |
| `SUM(ledger_entries.points)` (Balance, Req 1.2) | **450** | **500** |
| `SUM(point_lots.remaining_points)` over unexpired lots (Spendable, Req 1.3) | **250** | **500** |
| API `spendableBalance` | 250 ✅ matches spendable | 500 ✅ matches spendable |
| `customers.lifetime_spend_gbp` | `0.00` ✅ matches API | `350.00` ✅ matches API |
| `customers.tier` | `bronze` ✅ | `silver` ✅ |

So: **the API is faithfully reporting the derived spendable balance for both customers.**
The endpoint is correct.

What the cross-check *also* exposed is a data-integrity problem underneath it: for
customer `9037455327431`, Balance (450) ≠ Spendable (250), because two earning entries
have **no backing `point_lots` row** — `earn_signup` +50 (`signup_bonus`) and
`earn_referral` +150 (`referral_signup_bonus`). Since Spendable is derived solely from
lots, those 200 points can never be redeemed. A whole-table sweep found these are the
**only two** such rows across all 8 staging customers; every other customer reconciles
exactly (Balance = Spendable). See finding **F1**.

Also verified live: `customers.lifetime_points` (a documented cache, not truth) is `0` for
both audited customers while the true ledger balances are 450 and 500. The API does not
read that column, so no endpoint is affected — but the drift is real. See **F2**.

### 1.3 `GET /v1/history` (LIVE)

Customer `9037455327431` — 3 entries, `totalCount: 3`, `hasNextPage: false`:

| type | points | reason | date | orderReference |
| --- | --- | --- | --- | --- |
| `earned` | 250 | `referral_first_purchase_bonus` | `2026-07-26T13:03:32.388Z` | `null` |
| `earned` | 150 | `referral_signup_bonus` | `2026-07-26T13:01:32.831Z` | `null` |
| `earned` | 50 | `signup_bonus` | `2026-07-26T12:59:54.330Z` | `null` |

Customer `9037455425735` — 4 entries, `totalCount: 4`, order references present:

| type | points | reason | date | orderReference |
| --- | --- | --- | --- | --- |
| `earned` | 150 | `paid_order` | `2026-07-26T13:03:36.387Z` | `6600000000002` |
| `earned` | 100 | `first_purchase_bonus` | `2026-07-26T13:03:32.388Z` | `6600000000001` |
| `earned` | 200 | `paid_order` | `2026-07-26T13:03:32.388Z` | `6600000000001` |
| `earned` | 50 | `signup_bonus` | `2026-07-26T12:59:56.328Z` | `null` |

Verified properties:

- **Ordering**: most-recent-first, confirmed against `ledger_entries.created_at` in the DB.
- **Entry counts and points** match the DB exactly for both customers.
- **Dates** are ISO-8601 with `Z`.
- **Type mapping** is applied: the DB stores `earn_signup` / `earn_order` /
  `earn_first_purchase` / `earn_referral`; the API collapses them to `earned`, as the
  dashboard expects.
- **Pagination**: `pageSize=2&page=1` → 2 entries, `hasNextPage: true`; `page=2` → the
  remaining 2 entries, `hasNextPage: false`, no overlap, `totalCount: 4` on both pages.
- **Bounds**: `pageSize=1000` → `400 {"error":"invalid_pagination","message":"The 'pageSize' parameter must be between 1 and 100."}`.

Not verified: `spent` and `expired` entry rendering. Neither audited customer has any
(`redemptions` is empty for both), so the dashboard's discount-code extraction and the
"Points redeemed / expired" labels are **untested against live data**. Five `spend`
entries exist elsewhere in the table but not for a customer whose dashboard I could probe
in this pass. See **F12**.

### 1.4 `GET /v1/rewards` (LIVE)

Returned for both customers, byte-identical:

```json
{"rewards":[{"id":"reward_5","cost":100,"valueGBP":5},{"id":"reward_15","cost":250,"valueGBP":15},
{"id":"reward_35","cost":500,"valueGBP":35},{"id":"reward_75","cost":1000,"valueGBP":75}]}
```

That is exactly the required catalog — 100→£5, 250→£15, 500→£35, 1000→£75 — and it matches
the four hard-coded reward cards in `theme/sections/loyalty-dashboard.liquid:256–278`.
Verified. (It matches *today*; the theme does not consume this endpoint, so it can silently
drift — see **F7**.)

### 1.5 `GET /v1/referral` (LIVE)

| Field | `9037455327431` | `9037455425735` |
| --- | --- | --- |
| `referralCode` | `ATH-6JX5-CJQJ` | `ATH-GXXE-FV65` |
| `wasReferred` | `false` | `true` |
| `referredSignups` | `1` | `0` |
| `referredFirstPurchases` | `1` | `0` |

Cross-checked against the DB: `customers.referral_code` matches both codes exactly;
`customers.referred_by` for `9037455425735` points at `9037455327431`; the single
`referrals` row has `signup_rewarded = true` and `purchase_rewarded = true`, which is
consistent with `referredSignups: 1` / `referredFirstPurchases: 1` on the referrer. The
endpoint is correct.

**The dashboard never calls it.** `theme/assets/athoor-loyalty.js` contains zero
occurrences of "referral" (grep count: 0). The code shown on screen comes from a metafield
that does not exist, so the member is shown a fabricated code. See **F3** — this is the
most user-visible defect found.

### 1.6 `GET /v1/profile` — confirming what it does NOT return (LIVE)

Both customers returned:

```json
{"customerId":"<uuid>","purchasedFragrances":[],"favourites":[],"wishlist":[],
"recentlyViewed":[],"suggestions":[],"journey":[]}
```

`GET /v1/profile/journey` returned `{"milestones":[]}` for both.

Confirmed and recorded, **not fixed** (tasks 30/31 own this):

- `purchasedFragrances` and `suggestions` are **structurally** empty in production, not
  merely data-empty: `index.ts:166` constructs `new PgFragranceProfileDataSource(pool)`
  with no `shopify` source and no `suggestionEngine`, and the class defaults `shopify` to
  `EmptyShopifyFragranceSource` (`src/profile/fragranceProfile.ts:547`). (STATIC read,
  consistent with the LIVE empty response.)
- `favourites` / `wishlist` / `recentlyViewed` are Pg-backed and genuinely empty:
  `customer_favourites`, `customer_wishlist`, `customer_recently_viewed` all have **0 rows**
  in the live DB (LIVE). No storefront surface writes to them.
- **Benefits are not exposed by the API at all.** The `benefits` table holds 6 rows (LIVE),
  but no benefits route is registered in `src/routes/v1.ts` (STATIC). The dashboard's tier
  benefits table is static locale copy (`loyalty-dashboard.liquid:326–335`), so it can
  contradict the database with no detection.
- The dashboard does not consume `/v1/profile` at all — `athoor-loyalty.js` fetches only
  `/v1/balance`, `/v1/history?pageSize=20`, and `POST /v1/profile/visit`.

### 1.7 The API-failure fallback (Req 8.4) — does a usable fallback exist today? (LIVE)

`loyalty.*` customer metafields read from the staging Admin API (read-only GraphQL query):

| Metafield | `9037455327431` | true value | `9037455425735` | true value |
| --- | --- | --- | --- | --- |
| `points_balance` | **`50`** | 250 (spendable) ❌ | `500` | 500 ✅ |
| `lifetime_points` | **`50`** | 450 (ledger balance) ❌ | `500` | 500 ✅ |
| `tier` | `bronze` | bronze ✅ | `silver` | silver ✅ |
| `lifetime_spend_gbp` | `0.0` | 0.00 ✅ | `350.0` | 350.00 ✅ |
| `tier_progress_gbp` | `300.0` | 300 ✅ | `400.0` | 400 ✅ |
| `updated_at` | `2026-07-26T12:59:56.200Z` | — | `2026-07-26T13:03:38.347Z` | — |
| `referral_code` | **absent** | `ATH-6JX5-CJQJ` ❌ | **absent** | `ATH-GXXE-FV65` ❌ |

**Answer: yes, a fallback exists — and for one of the two customers it is materially wrong.**

- For `9037455425735` the fallback is accurate: a server render with no JS would show
  500 points, Silver, £350, £400 to go. Correct.
- For `9037455327431` the fallback would render **50 points** where the true spendable is
  **250** — a 5× understatement that also disables the 100- and 250-point reward cards that
  the member can actually afford, until JS lands. `metafields.updatedAt` for
  `points_balance` is `2026-07-26T15:46:48Z`, i.e. **after** the 13:01/13:03 referral
  credits, so a refresh ran and still wrote the stale figure. See **F4**.
- `loyalty.referral_code` **does not exist on either customer**, which is what triggers the
  fabricated-code fallback in **F3**.

### 1.8 Regression check (LIVE)

`npx vitest run` and `npm run build` in `loyalty-service/` — see §5. Nothing in this audit
modified application code, theme code, or database state.

---

## 2. What could NOT be verified, and why

Nothing in this section is "probably fine". Each item is genuinely unknown.

1. **No Lighthouse score for the dashboard exists.** The staging storefront is
   password-protected and we do not have the password. `GET /pages/rewards` and
   `GET /pages/loyalty` both return `HTTP/2 302` with `location:
   https://athoor-loyalty-staging.myshopify.com/password` (LIVE, headers captured).
   Lighthouse 12.8.2 was installed and **was** run against `/pages/rewards` for the record.
   It followed the redirect and audited the password gate:
   - `requestedUrl: .../pages/rewards`
   - `finalDisplayedUrl: .../password`
   - `dom-size: 26 elements`, `network-requests: 7`, `total-byte-weight: 82 KiB`,
     performance score `0.97`.

   **That 0.97 is the score of an empty password form and is meaningless for this task.**
   For scale: `layout/theme.liquid` alone loads jQuery (89 KB), Swiper (140 KB) and axios
   (21 KB) synchronously, so the real dashboard cannot resemble an 82 KiB / 26-element page.
   Performance, Accessibility, Best-Practices and SEO scores for the dashboard remain
   **outstanding**, and the Core Web Vitals targets (LCP < 2.5s, CLS < 0.1) are
   **unmeasured**.
2. **The staging theme could not be inspected or deployed.** The staging Admin token lacks
   `read_themes`: `{"errors":"[API] This action requires merchant approval for read_themes scope."}`.
   Consequence that matters for this whole document: **I cannot confirm that the theme
   staging serves is the theme in this repository.** The `server-timing` header on the 302
   discloses `theme;desc="159136088263"`, but not its contents. Every Part 2 finding below
   is against repo files; if staging runs an older theme, the findings may not correspond to
   what a member would see.
3. **No rendered responsive testing.** Breakpoints and overflow risks were read from CSS. No
   viewport from 320px to 1920px was actually rendered and measured.
4. **No screen-reader or keyboard testing.** No VoiceOver/NVDA pass, no real tab-order walk.
   Every accessibility finding below is automated/static analysis of markup and CSS. Full
   WCAG 2.1 AA conformance cannot be claimed from this; it requires manual testing with
   assistive technology and expert review.
5. **No axe/automated a11y run against a rendered DOM** — same root cause (no reachable page).
6. **`POST /v1/profile/visit` is unverified end-to-end.** It is state-changing, and this
   audit was scoped to read-only, so I did not call it. Supporting evidence that it has
   never run in staging: the `portal_visits` table has **0 rows** (LIVE). The first-visit
   welcome path (Req 16.1/16.2) is therefore completely unexercised.
7. **`spent` / `expired` history rendering unverified** — no such entries exist for the two
   probed customers (see **F12**).
8. **Meta Pixel presence on the live page unverified.** The theme source contains no `fbq(`,
   no `connect.facebook.net`, and no `ViewContent` / `AddToCart` / `InitiateCheckout` /
   `Purchase` event code (grep, whole `theme/`). If a pixel exists it is injected by Shopify
   via `content_for_header`, which can only be confirmed on a rendered page. See **F13**.
9. **Redemption is not wired to the API on the storefront**, so no live redemption flow could
   be exercised from the dashboard; the theme still uses `mailto:` CTAs (retained
   deliberately for M3 rollback).

---

## 3. Findings

Severity is about member impact and data correctness, not effort. "Method" is the crucial
column: **LIVE** = I observed it happening; **STATIC** = I read the code.

| # | Severity | Method | File / line | Finding | Impact | Recommended fix |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **Critical** | LIVE (DB + API) | live data; `src/reconciliation/reconcile.ts` | Customer `9037455327431` has Balance 450 but Spendable 250: `earn_signup` +50 and `earn_referral` +150 have **no `point_lots` row**. Only these 2 rows in the whole DB are affected. **Cause established by follow-up investigation — see §3.1: this is data we deleted during the task 28 expiry rehearsal, not a code defect and not pre-fix data.** | 200 points the member earned are unredeemable, and the dashboard cannot show them. Silent: nothing surfaces the gap. | Re-run the existing idempotent `scripts/backfill-missing-point-lots.mjs --apply` to recreate the two lots. Separately, add a reconciliation check that *detects* lot-less positive entries: `reconstructLotRemainders` recomputes remainders of **existing** lots only (STATIC read), so it can never repair or even notice a missing lot — today's reconciliation reports this customer as clean. |
| F2 | Medium | LIVE (DB) | `customers.lifetime_points` | Cached `lifetime_points` is `0` for both audited customers while true ledger balances are 450 / 500. | No endpoint reads it (the API derives from the ledger), so no member-visible impact today — but any future consumer or admin query that trusts the column reads zero. | Have reconciliation converge this cache (it is documented as reconcilable) or drop the column. |
| F3 | ~~**High**~~ **FIXED (task 34)** | LIVE + STATIC | `theme/sections/loyalty-dashboard.liquid:318`; `theme/assets/athoor-loyalty.js` (no `referral` reference) | The dashboard shows `customer.metafields.loyalty.referral_code`, else `ATHOOR-{first_name[0..4]}{customer.id \| modulo: 9999}`. That metafield **does not exist** on either staging customer (LIVE), so the rendered code is fabricated — e.g. `ATHOOR-REF3347` for `9037455327431`, whose real code is `ATH-6JX5-CJQJ`. `/v1/referral` is never called. | Members share a code the loyalty service does not recognise. Referrals attributed with it earn nobody anything, and the referral programme looks broken to the member and the referred friend. | Have `athoor-loyalty.js` fetch `/v1/referral` and write `referralCode` into `#ref-code`; and/or add `referral_code` to the metafield cache writer. Remove the fabricated fallback — render nothing (or a "generating" state) rather than a wrong code. |
| F4 | ~~**High**~~ **FIXED (task 35)** | LIVE + STATIC | `src/shopify/metafieldCache.ts:205`; `src/worker.ts:128–134`; grep: no `metafieldEnqueuer` in `src/earning/` or `src/referral/` | For `9037455327431` the fallback metafields read `points_balance: 50` / `lifetime_points: 50` against true 250 / 450. A cache refresh is enqueued from webhook-processed earnings, redemptions and admin adjustments, but **no referral-engine path enqueues one** — and this customer's only post-signup credits were referral bonuses. | The Req 8.4 fallback silently understates a member's balance by 5× and disables affordable rewards on first paint. Worse under Req 8.6, where the fallback is the only data shown. | Enqueue a metafield-cache refresh from the referral credit paths (`referral.ts:347,473`), same as the webhook earning path. Then re-run reconciliation to repair existing drift. |
| F5 | **High** | STATIC | `athoor-loyalty.css:161` | Silver tier badge: `#fff` on gradient `#C0C0C0 → #808080`. Computed contrast **1.82:1** at the light stop and **3.95:1** at the dark stop — both below the 4.5:1 AA threshold for 11px/600 text. | The tier name is illegible for low-vision users across most of the badge. A Silver member exists in staging today (`9037455425735`), so this renders in production conditions. | Darken the gradient (e.g. `#8E8E8E → #5F5F5F` gives ≥ 4.5:1 with `#fff`) or switch the Silver badge to dark text on the light metallic, as the Gold badge already does. |
| F6 | Medium | STATIC | `athoor-loyalty.css:160`, `:312`, `:317–320` | Three more computed text-contrast failures: bronze badge `#fff` on `#CD7F32` = **3.14:1**; `.reward-btn:hover` `#fff` on `#B8960C` = **2.84:1**; disabled `.reward-btn` `#fff` on `#8a8580` = **3.65:1**. | Bronze badge and the hovered primary CTA fail AA (hover states are in scope for 1.4.3). Disabled controls are technically exempt from 1.4.3 but the label is hard to read. | Bronze: use the darker stop or dark text. Hover: darken to ~`#7A6300` (≈ 5.3:1 with `#fff`) or keep `#1a1a1a` and change only the border. Disabled: `#6f665d` background gives ≥ 4.5:1. |
| F7 | Medium | STATIC + LIVE | `loyalty-dashboard.liquid:256–278` vs `GET /v1/rewards` | The four reward costs/values are hard-coded in Liquid and duplicated by `/v1/rewards`, which the theme never calls. They match today (verified LIVE). | Any future catalog change in the service silently diverges from the storefront; a member could be offered a reward the service will reject. | Render the cards from `/v1/rewards` (progressive enhancement, keeping the hard-coded set as the no-JS fallback), or add a test that asserts the theme values equal `REWARD_CATALOG`. |
| F8 | Medium | STATIC | `loyalty-dashboard.liquid:136–138` | When the metafield balance is 0 and `customer.total_spent > 0`, Liquid **invents** a balance: `points = total_spent × points_multiplier`. | The dashboard can display a points figure that exists in no ledger and no cache. It is not a stale value, it is a fabricated one — the same class of defect as F3. | Delete the fabrication. Show `0`, or the Req 8.6 unavailable notice, and let the API supply the truth. |
| F9 | Medium | STATIC | `loyalty-dashboard.liquid:169–175` (welcome `hidden`), `athoor-loyalty.js:revealWelcome`; also `:215`/`:232` (progress toggle), `:286` (codes), `:297` (activity) | Async-revealed regions shift layout: the first-visit welcome (a ~150px block with 32px padding) is un-hidden **at the very top of the page**, above the H1, after `POST /v1/profile/visit` resolves; the activity and codes sections are likewise revealed after `/v1/history`; and `updateProgress` toggles `display` between the two progress variants. No space is reserved for any of them. | Real CLS risk on the dashboard, and the worst offender pushes the page's main heading down. Numeric fields (balance/tier/spend) *are* server-rendered in place, so those are fine — the shift comes from the reveals. Cannot be quantified without a rendered page (§2.1). | Reserve space with `min-height` for the revealed regions, or render the welcome server-side from the visit state, or reveal it below the header. Re-measure CLS once a URL is auditable. |
| F10 | Medium | STATIC | `athoor-loyalty.js:applyBalance`, `renderActivity`, `renderCodes` | The balance, tier, progress, activity list and codes list are all replaced after fetch with **no `aria-live` region and no status announcement**. Only the error notice has `role="status" aria-live="polite"` (`loyalty-dashboard.liquid:94–99`). | A screen-reader user who has already read "50 points" is never told it became 250. The progressbar's `aria-valuenow`/`aria-label` *are* updated (good), but silently. | Wrap the stats group in a polite live region, or announce a short summary ("Balance updated: 250 points") into a visually-hidden `role="status"` element after `applyBalance`. |
| F11 | Medium | STATIC | `layout/theme.liquid:44,45,49,50`, `:290`, `:316` | The dashboard page inherits four **parser-blocking** scripts in `<head>` — jQuery (89 KB, `:44`), axios (21 KB, `:45`), Swiper (140 KB, `:49`), jquery-cookie (1.3 KB, `:50`) — with `theme-check`'s `ParserBlockingJavaScript` rule explicitly disabled around them, plus **two synchronous third-party requests**: `cdnjs.cloudflare.com/.../gsap/3.12.5/gsap.min.js` (`:316`) and a Font Awesome 4.7 stylesheet from cdnjs (`:290`), and a Three.js/GSAP import map. ~250 KB of blocking JS before the loyalty surface can paint. | Directly attacks LCP/TBT on the dashboard. The third-party sync script and stylesheet also make render dependent on cdnjs availability. | `defer` what can be deferred, load GSAP from the theme (or `defer`), and drop libraries not used on this template. **Confirmed for the record:** the loyalty code does not use axios — `athoor-loyalty.js` uses `fetch` and grep finds no `axios` reference in it. Axios is pulled in by `dt_wishlist.js`, not by loyalty, so it is avoidable weight on this page. |
| F12 | Medium | LIVE | `athoor-loyalty.js:renderCodes`, `extractCode` | Neither probed customer has any `spent` or `expired` entry (`redemptions` empty for both, LIVE), so the discount-code chip extraction (`/\b[A-Z0-9][A-Z0-9-]{3,}\b/` over `reason`) and the redeemed/expired labels are **unexercised against live data**. The regex would also match a non-code token in a reason string. | Unknown behaviour on the exact path a redeeming member hits. | Probe a customer with `spend`/`expire` entries (five `spend` rows exist in the DB), or better: surface the code from a dedicated field instead of regex-scraping a human-readable reason. |
| F13 | Medium | STATIC | whole `theme/` (grep) | No Meta Pixel code in the theme: no `fbq(`, no `connect.facebook.net`, no `ViewContent` / `AddToCart` / `InitiateCheckout` / `Purchase`. | Cannot confirm required events fire, cannot check for duplicate fires, cannot check `content_ids`/`value`/`currency`. If the pixel arrives only via `content_for_header`, coverage depends on the Shopify channel app config, which is invisible from the repo. | Verify on a rendered page with the Meta Pixel Helper once the storefront is reachable. Deliberate no-finding: I am not claiming the pixel is absent from the live site, only that it is absent from theme source. |
| F14 | Low | STATIC | `athoor-loyalty.css:235,242` | Non-text contrast (WCAG 1.4.11, 3:1): progress track `#e5e5e5` on the `#fafafa` card = **1.21:1**; fill `#B8960C` on track = **2.25:1**; fill light stop `#FFD700` on track = **1.11:1**. | The progressbar — an element with `role="progressbar"` conveying real information — has boundaries and a fill that low-vision users may not be able to distinguish. | Darken the track (e.g. `#c9c4bc`, ≥ 3:1 against both card and fill) and drop the light gold stop, or add a 1px darker outline. |
| F15 | Low | STATIC | `loyalty-dashboard.liquid:169` vs `:177` | Heading order: the `pc-welcome` `<h2>` precedes the page `<h1>` in DOM order. It is `hidden` by default, so the violation only materialises for first-visit members when JS reveals it. | Heading-order (1.3.1) violation on exactly the first impression a new member gets. | Move the welcome below the header, or make its title a `<p>` styled as a heading. |
| F16 | Low | STATIC | `loyalty-dashboard.liquid:189`; `locales/en.default.json` | `role="group" aria-label="Membership summary"` is hard-coded English, while the key `loyalty.summary_label` **already exists** in the locale file and is unused. | Non-English members get an English accessible name on the stats group. | Use `{{ 'loyalty.summary_label' \| t }}`. |
| F17 | Low | STATIC | `snippets/rewards-banner.liquid:40,65` | The banner's copy is hard-coded English in markup *and* in JS (`'You have ' + points + ' Athoor Rewards points — View & Redeem'`), while `loyalty.banner.join_message` and `loyalty.banner.balance_message` exist in the locale file and are unused. Verified by key-diff: all 90 keys the section uses exist; exactly these two plus `loyalty.summary_label` are defined-but-unused. | Site-wide banner is untranslated, unlike the rest of the surface. | Render both strings via `t` into `data-` attributes and have the inline script read them. |
| F18 | Low | STATIC | `loyalty-dashboard.liquid:1` | `athoor-loyalty.css` is injected by `stylesheet_tag` **inside the section body**, so the render-blocking stylesheet is discovered late in the document. | Delays first paint of the dashboard; a late-discovered blocking stylesheet is worse than one in `<head>`. | Move to `layout/theme.liquid` behind a template condition, or `preload` it. (The `<script defer>` at `:364` is correct — no change needed there.) |
| F19 | Low | STATIC | `layout/theme.liquid:323` (banner) vs `:325` (skip link) | The rewards banner link is rendered **before** the skip-to-content link, making it the first focusable element on every page of the site. | Keyboard users must tab past a marketing link to reach "skip to content"; weakens 2.4.1 in practice even though the bypass exists. | Render the banner after the skip link. |
| F20 | Low | STATIC | `loyalty-dashboard.liquid:319` | The copy-code control is an inline `onclick` calling `navigator.clipboard` with no failure path, and it announces success only by mutating its own `innerText` (no `aria-live`, no `role="status"`). | On browsers/contexts where the Clipboard API is unavailable or permission-denied, nothing happens and nothing is reported. Screen-reader users may not hear "Copied". | Move to `athoor-loyalty.js`, add a `try/catch` with a `document.execCommand('copy')` or select-the-text fallback, and announce via a visually-hidden `role="status"`. |
| F21 | Low | STATIC | `loyalty-dashboard.liquid:260,265,270,275` | All four redemption CTAs are `mailto:` links embedding `{{ customer.email }}` in the `body` query parameter. (Retained deliberately for M3 rollback — not a defect to "fix" now.) | The member's email is written into a link URL, so it can be leaked by referrer/analytics tooling that captures link URLs, and it is copy-pasteable from the status bar. | When `/v1/redeem` is cut over, drop the email from the URL. Until then, note it as an accepted risk. |
| F22 | Informational | LIVE | staging shop currency | The staging shop reports `currencyCode: USD` on customers' `amountSpent`, while the service reports GBP (`lifetimeSpendGBP`). `athoor-loyalty.js` formats API GBP figures with `Intl.NumberFormat('en-GB', { currency: shop.currency })`. | On this staging store, £350 would render as `$350.00`. Almost certainly a staging-config artefact, not a production bug (production is a GBP store) — flagged so it is not mistaken for a code defect during staging QA. | Set the staging store to GBP, or format with a fixed `GBP` since the API contract is GBP-denominated. |
| F23 | Informational | LIVE + STATIC | `athoor-loyalty.js:markVisit` | The dashboard fires 3 requests on load — `GET /v1/balance`, `GET /v1/history?pageSize=20`, `POST /v1/profile/visit` — **in parallel**, each with a hard 3s timeout, all independent. This is the right shape. Note that the third is a **write on every page load** (fresh `Idempotency-Key` per load, deliberately). `portal_visits` has 0 rows (LIVE), so this has never actually run in staging. | No performance concern (parallel, bounded, silent fallback). Recorded because a per-load write is easy to mistake for a bug later. | No change. Verify once a page is reachable. |

### 3.1 F1 root cause — we caused it, during the task 28 rehearsal (LIVE)

The audit's first hypothesis was "pre-fix data from before Property 17 landed". That is
**wrong**, and the correction matters more than the original finding, so the evidence is
recorded here.

Facts established by direct query:

- The customer was created `2026-07-26T12:59:54Z`, which is **after** Property 17 and its
  backfill (task 5). Pre-fix data is therefore impossible.
- `createExpiringPointLot` (`src/ledger/pointLots.ts:80`) skips an entry only when
  `entry.points <= 0`. All three entries are positive, and current source calls it on the
  signup path (`earning/signup.ts:202`) and on **both** referral paths
  (`referral/referral.ts:347` and `:473`). The code would have created all three lots.
- The `+250` `referral_first_purchase_bonus` lot **does exist**, with a correct 12-month
  expiry. So the referral machinery was demonstrably creating lots in that same session.
- There are **zero `expire` ledger entries** for this customer, so the missing lots were not
  expired and zeroed — they are absent, not drained.
- Task 25's recorded staging evidence explicitly stated balance == spendable == 450 for this
  customer. So the lots existed then and do not now.

What happened in between: the **task 28 expiry rehearsal** seeded five synthetic lots on this
same customer and then deleted its test data. Two of the seeded lots had remaining values of
**50 and 150** — exactly the two amounts now missing — while no seeded lot was 250, which is
exactly the one that survived. The cleanup evidently matched real lots that shared the
synthetic amounts.

Two lessons, both worth more than the 200 points:

1. **A validation run mutated real ledger-adjacent data on a shared live database, and the
   damage was invisible for two tasks.** Reconciliation cannot detect a missing lot, and
   nothing else checks Property 17 at runtime, so `balance != spendable` sat there silently
   until a dashboard audit happened to cross-check the two definitions.
2. **Test data seeded on a real customer must be deleted by primary key**, never by value.
   Future rehearsals should seed a dedicated throwaway customer, or capture the exact ids
   they insert and delete only those.

The remedy is non-destructive and already exists: `scripts/backfill-missing-point-lots.mjs`
is idempotent, dry-run by default, atomic, and only ever INSERTs lots for positive entries
that have none. It has not been run — that needs approval, since it writes to the live
ledger's lot table.

### Things I checked and found genuinely correct (STATIC, unless noted)

Not everything is a finding, and it is worth being specific about what holds up:

- **Contrast, the parts that pass**: 21 of 25 text pairs clear AA with real margin —
  `--athoor-gold-text: #8C6B00` on white = **4.98:1**, on `#fafafa` cards = **4.77:1**;
  `--athoor-muted-text: #6f665d` = **5.62:1** / **5.39:1**; ink `#1a1a1a` on white =
  **17.40:1**; `#FFD700` on `#1a1a1a` = **12.41:1**; the dark referral panel's `#aaa` body
  copy = **7.49:1**; the amber unavailable notice `#7a6a3a` on `#fbf7ef` = **4.98:1**; the
  Gold badge's `#1a1a1a` on `#FFD700`/`#B8960C` = **12.41:1** / **6.14:1**; the current-tier
  row (`rgba(184,150,12,0.04)` composited to `#FCFBF5`) = **13.85:1**. The palette comments
  claiming AA are accurate.
- **Focus visibility**: `:focus-visible` rings on `a`, `button` and `[tabindex]`
  (`athoor-loyalty.css:42–47`), 2px solid `#8C6B00` with 2px offset — **4.98:1** against
  white and **4.77:1** against the cards, so the ring itself passes 1.4.11.
- **Interactive semantics**: real `<a>` and `<button>` elements throughout. No `div` with a
  click handler anywhere in the loyalty surface. Disabled reward CTAs are removed from the
  tab order *and* the accessibility tree consistently in both Liquid (`:260–275`) and JS
  (`updateRewardCards`) — `class`, `aria-disabled`, `tabindex="-1"` and `pointer-events:
  none` all move together.
- **Forms**: there are no inputs on the dashboard, so there are no unlabelled inputs. (Also
  means there is no referral-code entry field, so the `POST /v1/referral` path has no
  storefront surface at all — a gap, not an a11y defect.)
- **Images**: the loyalty surface contains **no `<img>` at all** (grep). So: no missing
  `alt`, no missing dimensions, no lazy-loading or `srcset` work needed here, and the LCP
  element is almost certainly the H1 greeting or a stat value — text, not an image. Nothing
  above the fold is lazy-loaded.
- **Fonts**: the loyalty CSS declares no `@font-face` and uses Georgia + system UI stacks,
  so it adds no webfont latency and no FOIT. The theme's own fonts already use
  `font_display: 'swap'` (`layout/theme.liquid`).
- **Motion**: `prefers-reduced-motion: reduce` is honoured (`athoor-loyalty.css:577–592`),
  the progress reveal exists only under `no-preference` (`:563`), and transitions are
  restricted to `transform`/`opacity` with hover colour/shadow changes applied instantly.
  All durations are ≤ 300ms. This matches the standard, and the `transition: all` that used
  to be here is gone.
- **Liquid efficiency**: no `for` loops, no nested collection/product access, no N+1
  pattern; `assign` used throughout rather than `capture`; the tier ladder is a single
  if/elsif chain. The tier thresholds in Liquid (300 / 750 / 1500) match the live API's
  `nextTierThresholdGBP` (300 for bronze, 750 for silver) — cross-checked LIVE.
- **Table semantics**: `<caption class="sr-only">`, `<thead>`, `scope="col"` on every header,
  and a dedicated `.tiers-table-wrap` with `overflow-x: auto` so the 4-column table scrolls
  itself instead of the page.
- **Responsive (STATIC — no rendered testing)**: exactly two breakpoints exist in the
  loyalty CSS, both `@media screen and (max-width: 749px)` (`athoor-loyalty.css:132`, `:502`),
  plus one in the banner snippet. The only fixed dimension is `max-width: 1000px` on the
  container; everything else is `1fr` / `auto-fit minmax()` / percentage. At 320px the
  content box is 288px (16px padding) with a 2-column stats grid at 12px gap = 138px cells,
  which fits. The referral chip stacks vertically at ≤749px and the code has
  `overflow-wrap: anywhere`. I found **no fixed pixel widths and no obvious overflow source**
  between 320px and 1920px. Between 750px and 1000px the `auto-fit` stats grid will reflow
  4→3+1, which is untidy but not broken. **This is code reading, not measurement.**
- **API-failure contract**: hard 3s `AbortController` timeout on every request, non-OK and
  network errors both fall through to the server-rendered values, `fetch`/`AbortController`
  absence is guarded, and the Req 8.6 notice is shown only when the cache is also
  unavailable. The logic is sound; the problem is the *content* of the fallback (F4).

---

## 4. What is needed to finish task 27

Only the store owner can unblock these. Until then task 27 cannot be closed.

1. **Storefront password for `athoor-loyalty-staging.myshopify.com`** (Online Store →
   Preferences → Password protection), or the storefront password removed, or a
   preview/share link that bypasses it. Without this there is **no auditable URL** and no
   Lighthouse score, no rendered responsive testing, no axe run, no CLS measurement, and no
   Meta Pixel verification.
2. **A logged-in staging customer session** on a customer whose ledger has data (e.g.
   `9037455327431` or `9037455425735`). Lighthouse must run on the authenticated dashboard —
   the logged-out "join" branch is a different page. This needs either a password for a test
   customer account or a Shopify customer-account login link.
3. **`read_themes` (and `write_themes` if the fixes above are to be deployed) granted to the
   staging Admin app.** Required to confirm the deployed theme matches this repository —
   without it, every static finding here is provisional.
4. **Confirmation of which page is canonical** — both `templates/page.rewards.json` and
   `templates/page.loyalty.json` render the `loyalty-dashboard` section, and the site-wide
   banner links to `/pages/rewards`. Both need auditing, or one needs retiring.
5. **A decision on F1** (backfilling the two lot-less earning entries) and on **F3/F4**,
   which are storefront-visible correctness defects rather than polish.
6. **Meta Pixel configuration detail** — whether the Facebook & Instagram channel is
   installed on staging, so pixel coverage can be assessed rather than guessed.

### Suggested order once unblocked

1. Fix F3 and F4 (members currently see a wrong referral code and, in one case, a 5×
   understated balance).
2. Fix F5/F6 (measured contrast failures — cheap, and F5 affects a live Silver member).
3. Run Lighthouse on the authenticated dashboard and record the four scores plus LCP/CLS/TBT
   in this document, replacing §2.1.
4. Re-measure CLS specifically against F9 before deciding how much layout reservation is
   needed.
5. Run axe on the rendered page, then a manual keyboard + screen-reader pass — the part
   static analysis cannot substitute for.

---

## 5. Evidence and regression status

- Live API responses, the DB cross-check, the contrast arithmetic, the storefront redirect
  headers and the Lighthouse run were captured to a scratch directory during the audit and
  are summarised inline above. The scratch directory was removed; nothing was committed.
- No application code, theme file, database row, Shopify resource or Shopify metafield was
  modified by this audit. All API calls were `GET`; all SQL ran inside `BEGIN READ ONLY`
  followed by `ROLLBACK`.
- Regression check after the audit: `npx vitest run` → **107 files, 1165 tests, all passed**;
  `npm run build` (`tsc -p tsconfig.json`) → clean, exit 0. Nothing was disturbed.

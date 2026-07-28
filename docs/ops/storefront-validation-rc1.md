# Storefront validation — RC1 measurement pass (task 27)

**Date:** 2026-07-28 · **Store:** `athoor-loyalty-staging.myshopify.com` (staging dev store)
**Theme:** `Copy of test-data` (`159243665607`) — **unpublished preview** · **Page:** `/pages/rewards`
**Tools:** Lighthouse 12.8.2, axe-core 4.10.2, Chrome 150 over CDP on port 9222

> **These are not production results.** The measurement ran on an unpublished
> preview theme carrying Shopify's preview bar (364 KB, 19.2% of page weight) and
> Dawn-derived global settings, because `config/settings_data.json` was rejected on
> upload. A production re-measure is task 51.

## Session

A real authenticated customer session, not a reconstruction: storefront password
session plus customer `9038732689607` (`JUMANPTB@GMAIL.COM`) signed in. Verified
from inside the page — `Shopify.theme.id` returned `159243665607`,
`ShopifyAnalytics.meta.page.customerId` returned the customer id, and the
dashboard's **own** fetch of `/apps/loyalty/v1/balance` returned `200` with live
ledger data (1099 spendable, gold).

## Verified — our implementation

Everything measured inside `.loyalty-dashboard` passed.

| Check | Result |
|---|---|
| axe-core scoped to `.loyalty-dashboard`, WCAG 2.0/2.1 A + AA | **0 violations**, 20 passes, 1 needs-review |
| Keyboard focus indicators (real Tab events) | Solid 2px `rgb(140,107,0)` outline + box-shadow, `:focus-visible` true, on every Redeem link, Copy button, referral input and Apply |
| Focus order | Logical; no positive `tabindex`; no traps; focus exits cleanly |
| `prefers-reduced-motion: reduce` | 0 animations, 0 transitions across 144 nodes (1 and 13 without it) |
| Responsive 320/375/414/768/1024/1280/1440/1920 | **No horizontal overflow at any width**; caps at 1000px |
| `tiers-table` at 320px | Deliberate scroll container — `.tiers-table-wrap` `overflow-x: auto`, scrollWidth 363 vs clientWidth 288, document overflow false. Not clipped |
| Dashboard CLS contribution | **0.00012** (`.tier-progress` 0.000073 + `p.subtitle` 0.00005) |
| Dashboard payload | **11 KB** — css 2 KB, js 4 KB, four API responses ~4 KB |
| App Proxy latency | 387–432 ms across `/v1/balance`, `/v1/history`, `/v1/referral`, `/v1/profile/visit`, all `200` |

## Lighthouse scores as measured

| | Mobile | Desktop |
|---|---|---|
| Performance | 88 | 95 |
| Accessibility | 93 | 93 |
| Best Practices | 96 | 74 |
| SEO | 92 | 92 |

| Metric | Mobile | Desktop | Target |
|---|---|---|---|
| FCP | 1.5 s | 0.4 s | — |
| **LCP** | **3.7 s** | 1.0 s | < 2.5 s — mobile misses |
| **CLS** | 0 | **0.103** | < 0.1 — desktop marginally misses |
| TBT | 10 ms | 0 ms | — |
| Speed Index | 3.4 s | 1.2 s | — |
| Max potential FID | 50 ms | — | < 100 ms |

## Environmental — attributed away from our implementation

**`link-name`, 5 nodes** — header/footer chrome: `.header__icon--wishlist`,
`.header__icon--compare`, `#cart-icon-bubble`, `.header__icon--account`, footer
logo link. Outside the dashboard. → task 47

**`frame-title`, 1 node** — `iframe#PBarNextFrame` from
`cdn.shopify.com/shopifycloud/preview-bar/`. Shopify's preview bar, present only
because the theme is unpublished. Will not exist in production.

**Desktop CLS 0.103 — 91% one non-dashboard element:**

| Contributor | Score | Owner |
|---|---|---|
| `button.disclosure__button::before` | 0.0943 | Dawn language/currency disclosure |
| `ul.dt-sc-list-inline` (header nav) | 0.0063 | Base theme |
| `#horse-cursor` | 0.0009 | Theme cursor effect |
| `.tier-progress` + `p.subtitle` | 0.00012 | **Ours** |

→ task 48

**Mobile LCP 3.7 s — element ours, cause not.** The LCP element is `p.subtitle`
in `.loyalty-header`, a server-rendered Liquid string. Phases: TTFB 16 % (612 ms),
load delay 0, load time 0, **render delay 84 % (3,126 ms)**. There are zero
render-blocking resources, `font-display` passes, and our API calls take ~430 ms.
The delay is main-thread and bandwidth contention on a 1,898 KB page:

| Source | Bytes | Share |
|---|---|---|
| Shopify accounts / Shop Pay bundles | 565 KB | 29.8 % |
| Shopify platform scripts / analytics | 432 KB | 22.8 % |
| **Shopify preview bar** (unpublished only) | 364 KB | 19.2 % |
| Base / Athoor theme assets | 215 KB | 11.4 % |
| Images | 136 KB | 7.2 % |
| **Loyalty dashboard (ours)** | **11 KB** | **0.6 %** |

→ task 51

**Two console errors** — `SyntaxError: Unexpected token '...'` and
`TypeError: ... reading 'cloneNode'` at page line 1795, from an inline theme
script, not `athoor-loyalty.js`. **Ownership unproven**, recorded as unattributed
rather than guessed. → task 50

## Method corrections

Two of the auditor's own findings were false positives and were corrected before
reporting, because the method changed the conclusion:

1. An initial keyboard check used programmatic `.focus()`, which does not trigger
   `:focus-visible`, and wrongly reported missing focus indicators. Re-running
   with real Tab key events showed they are correct.
2. An initial byte-attribution matched the string `athoor-loyalty` against the
   store's own **domain**, wrongly assigning 1,344 KB to the dashboard. The true
   figure is 11 KB.

## Task 26 M2 evidence

| M2 requirement | Evidence |
|---|---|
| Webhooks registered, HMAC verified on receipt | 4 topics live at API version 2026-07, all → the service |
| Events recorded and processed | `customers/create` 4 processed, `orders/paid` 4 processed |
| Ledger records new activity | balance 1099, spendable 1099, tier gold, spend £949.95 |
| Metafield cache still written | `points_balance` 1099, `lifetime_points` 1099, `tier` gold, `lifetime_spend_gbp` 949.95, `tier_progress_gbp` 550.05, referral code |
| **Shadow comparison** | **All four fields AGREE between ledger and cache** |

Satisfies M2's parallel-run requirement.

## Not claimed

Full WCAG 2.1 AA conformance is **not** claimed. axe plus a keyboard pass covers a
subset; genuine conformance needs manual assistive-technology testing and expert
review. Meta Pixel is unmeasured on staging by owner decision → task 52.

Raw axe result: `evidence/axe-rc1.json`. Lighthouse reports are reproducible with
`npx lighthouse@12 <url> --port=9222`.

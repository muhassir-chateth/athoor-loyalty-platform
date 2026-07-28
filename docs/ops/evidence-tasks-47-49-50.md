# Evidence — tasks 47, 49 and 50

Captured 2026-07-28 against the **unpublished** staging theme `159243665607`
("Copy of test-data") on `athoor-loyalty-staging.myshopify.com`.

The live theme `159136088263` (`MAIN`, "test-data") was **never written**. The
upload script hard-refuses that id and independently re-reads the target theme's
role before writing; the recorded roles at upload time were
`159136022727=UNPUBLISHED 159136055495=UNPUBLISHED 159136088263=MAIN 159243665607=UNPUBLISHED`.

Production (`myathoorlondon.myshopify.com`) was not contacted.

## What changed

| File | Task | Change |
|---|---|---|
| `theme/layout/theme.liquid` | 50 | Removed the never-executing scroll block containing a literal `...` |
| `theme/sections/marquee-section.liquid` | 50 | Rewrote the clone loop; removed two `console.log` |
| `theme/sections/header.liquid` | 47 | `aria-label` on wishlist, compare, cart, account links |
| `theme/sections/footer.liquid` | 47 | `aria-label` on both logo anchors |
| `theme/locales/en.default.json` | 47 | Added `products.product.compare: "Compare"` |
| `loyalty-service/src/theme/marqueeClone.dom.test.ts` | 50 | New — 12 jsdom regression tests |

The locale file was a **fifth** file, beyond the four planned. It was required
because the compare `aria-label` referenced a key that did not exist; see below.

## Upload integrity

Every uploaded file is byte-identical between the repo and what the theme stores
(sha256, first 16 hex chars):

```
MATCH   layout/theme.liquid                local=8641e342774d4266 remote=8641e342774d4266 2026-07-28T02:59:15Z
MATCH   locales/en.default.json            local=6ec2fc3043b61dbf remote=6ec2fc3043b61dbf 2026-07-28T03:06:43Z
MATCH   sections/footer.liquid             local=e9d58976c44cbb7b remote=e9d58976c44cbb7b 2026-07-28T02:59:15Z
MATCH   sections/header.liquid             local=3379032df3033adc remote=3379032df3033adc 2026-07-28T02:59:15Z
MATCH   sections/marquee-section.liquid    local=6da481959d1627c6 remote=6da481959d1627c6 2026-07-28T02:59:15Z
```

`themeFilesUpsert` returned all five filenames with `userErrors: []`.

## Task 47 — accessible names

Names taken from the **browser's accessibility tree** via CDP
`Accessibility.getPartialAXTree`, not inferred from attributes.

| Link | Selector | Role | Accessible name |
|---|---|---|---|
| Header wishlist | `a.header__icon--wishlist` | link | `Wishlist` |
| Header compare | `a.header__icon--compare` | link | `Compare` |
| Header cart | `a#cart-icon-bubble` | button | `Cart` |
| Header account | `a.header__icon--account` | link | `Account` |
| Footer logo | `#shopify-section-footer .footer-block > a[href]` | link | `athoor-loyalty-staging` |

axe on `/pages/rewards`, naming rules:

```
violations: frame-title  serious  1 node  [#PBarNextFrame]
passes:     link-name 15 · button-name 3 · aria-allowed-attr 22 · aria-valid-attr-value 22
```

`link-name`: **0 violations, 15 nodes passing.** The single remaining violation
is Shopify's own preview-bar iframe, which exists only because the theme is
unpublished and disappears on publication.

### The compare link needed a locale key

The first measured run returned the accessible name
`"Translation missing: en.products.product.compare"`. The key did not exist in
`locales/en.default.json`. The pre-existing hidden `.icon__fallback-text` span
used the same missing key, so the string was already in the DOM and merely
invisible. Added `products.product.compare: "Compare"` beside the existing
`wishlist` key. `Translation missing` now occurs **0 times** on `/pages/rewards`
and `/collections/all`.

Note the file carries Shopify's auto-generated header comment warning that the
admin language editor may overwrite it.

## Task 49 — rewards page SEO

`PageUpdateInput` exposes no `seo` field (verified by introspection:
`handle, body, isPublished, publishDate, templateSuffix, metafields, title, redirectNewHandle`),
and `Page` has no `seo` field in Admin API 2025-01. Page SEO is the reserved
`global.title_tag` / `global.description_tag` metafield pair, which is what
Liquid's `page_title` and `page_description` resolve to.

Before → after on `gid://shopify/Page/131647701191` (handle `rewards`):

```
title           "Rewards"                       →  "Rewards"          (deliberately unchanged)
title_tag       null                            →  "Rewards & Loyalty | My Athoor London"
description_tag null                            →  "Join My Athoor London Rewards to earn points,
                                                    unlock exclusive benefits, redeem rewards and
                                                    progress through our loyalty tiers."
```

Rendered page:

```
document.title            "Rewards & Loyalty | My Athoor London – athoor-loyalty-staging"
meta[name=description]    full description present
visible heading           "Welcome to the Athoor Private Client Circle"  (unchanged)
```

The ` – athoor-loyalty-staging` suffix is a **staging artefact**: `theme.liquid`
appends `– {{ shop.name }}` unless the title already contains it. On production
the real store name will be contained in the title, so no suffix. Confirm in
task 51.

## Task 50 — console errors

### Attribution

`SyntaxError: Unexpected token '...'` — `theme/layout/theme.liquid`. A literal
`...` placeholder inside a scroll-listener block. Because that is a parse error,
the **entire block never executed on any page**; it only produced the console
error. Removed rather than completed, and a Liquid comment records why.

`TypeError: Cannot read properties of undefined (reading 'cloneNode')` —
`theme/sections/marquee-section.liquid`. The clone loop bounded itself by the CSS
custom property `--marquee-inview-blocks` while indexing live DOM children, and
appended into the same collection it indexed. Live staging state:
`ul.marquee-wrapper` present with **0 items** while `--marquee-inview-blocks` is
**4**, so `children[0]` was `undefined` on every page load.

Neither error came from loyalty code; `athoor-loyalty.js` was checked and cleared.

### Live result, cache disabled

`Network.setCacheDisabled` plus `Page.reload{ignoreCache}`, with the rendering
theme asserted on each load.

| Page | `Shopify.theme` | Console errors |
|---|---|---|
| `/pages/rewards` | `159243665607` / unpublished | favicon 404 only |
| `/` | `159243665607` / unpublished | favicon 404 only |
| `/collections/all` | `159243665607` / unpublished | favicon 404 only |

Both original errors are **gone from all three**, and the shipped inline script
was confirmed to contain `const originalItems` and **not**
`marqueeContent.children[i]` — which ties the jsdom suite to the deployed code.

The favicon `404` is **pre-existing and environmental**: `theme.liquid` emits an
icon link only when `settings.favicon` is set, the rendered page contains zero
`link[rel~=icon]` elements, so the browser issues its own default
`/favicon.ico` request. Nothing in this change touches favicon handling.

### A false negative worth recording

The first verification run reported **both errors still present** while the Admin
API read-back already showed the corrected files stored on the theme. The cause
was cache, not the fix: the tab already sat on `/pages/rewards`, Shopify strips
`preview_theme_id` and redirects to the clean URL, and Chrome reused the cached
document. Any future storefront verification must disable the cache and assert
`Shopify.theme.id` rather than trusting the requested URL.

### Regression cover

`loyalty-service/src/theme/marqueeClone.dom.test.ts` — 12 jsdom tests. The liquid
file is not importable, so the corrected algorithm is mirrored and exercised
across 0 / 1 / fewer-than-in-view / equal / more-than-in-view item counts, plus
unset, non-numeric, whitespace, zero and negative CSS values, and an assertion
that no appended node is ever re-cloned.

Suite: **1523 passing, 130 files** (was 1511 / 129). `npm run build` clean.

## Loyalty dashboard unaffected

axe scoped to `.loyalty-dashboard`: **0 violations, 29 passes, 1 incomplete.**
The dashboard rendered signed-in with tier and points intact
(`dashboardHasTier: true`, points text present, 1327 characters of content).

## New finding, opened as task 53 rather than folded in

Extending the naming sweep beyond the agreed scope found **12 further axe
`link-name` violations** on the home page: `a.add-compare` and `a.add-wishlist`
inside `dtx-compare` / `dtx-wishlist` in every featured-collection product card.
`/collections/all` had none. The same cards emit
`Translation missing: en.products.compare.add_to_compare` six times as **visible**
tooltip text — a different key from the one task 47 added, in the product-card
snippet rather than the header, so pre-existing.

## Not done, deliberately

- No theme was published; `MAIN` is untouched.
- No scope change, no Gate 0 work, no M0/M1/M2.
- Task 48 (desktop CLS) left open by owner instruction.
- The `/pages/loyalty` → `/pages/rewards` 301 still requires
  `write_online_store_navigation`, which is not granted.

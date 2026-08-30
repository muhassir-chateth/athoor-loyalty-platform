# Task 30.3 — real-browser width pass

Measured in headless Chrome over CDP. 10 sections x 8 widths = 80 measurements.

## Horizontal overflow (scrollWidth > width)

**0 of 80**

## Bottom bar: fixed below 750, released at 768

| width | position | visible targets | min target h x w |
|---|---|---|---|
| 320 | fixed | 5 | 56 x 64 |
| 375 | fixed | 5 | 56 x 75 |
| 390 | fixed | 5 | 56 x 78 |
| 414 | fixed | 5 | 56 x 83 |
| 768 | static | 8 | 44 x 67 |
| 1024 | sticky | 8 | 44 x 220 |
| 1280 | sticky | 8 | 44 x 220 |
| 1920 | sticky | 8 | 44 x 220 |

## Wishlist grid columns (1-up below 390, 2-up at 390)

| width | columns |
|---|---|
| 320 | no grid element in fixture |
| 375 | no grid element in fixture |
| 390 | no grid element in fixture |
| 414 | no grid element in fixture |
| 768 | no grid element in fixture |
| 1024 | no grid element in fixture |
| 1280 | no grid element in fixture |
| 1920 | no grid element in fixture |

## What is now MEASURED, and what is still not

The scaffold in `portal-section.liquid` carries a ONE-ITEM stub nav, so the first pass could
measure nothing depending on the real child count — it printed "1 visible target / 56 x 320",
which described the stub. The fixture now injects the real nine-item nav, with the entry list,
labels, hrefs, the four-in-the-bar rule and the markup shape all **parsed out of
`portal-nav.liquid`**, so reordering `nav_items` or renaming a label follows automatically.
Derived, not Liquid-rendered — that is the honest limit of this harness.

| 30.3 requirement | Status |
|---|---|
| `scrollWidth <= width` per section, 8 widths | **MEASURED — 0 failures of 80** |
| bar fixed below 750, released at 750 | **MEASURED — fixed below 750, `static` at 768** |
| five bottom-bar targets at 320 | **MEASURED — exactly 5** (four primary + More) |
| every target >= 44px at 320 | **MEASURED — min 56 x 64 px** |
| eight entries once the bar releases | **MEASURED — 8 at 768 and above** |
| wishlist 1-up/2-up boundary at 390 | **NOT measured** — no grid container in the wishlist fixture |
| no clipped text | **NOT measured** — needs per-element overflow comparison |
| mobile keyboard case | **NOT measurable here** — real device |
| the live storefront render | **NOT measurable here** — authenticated preview session |

The four unmeasured clauses remain gated **statically** by
`portalResponsivePreconditions.test.ts`. 30.3 stays **unticked** until they are measured.

A harness measuring the wrong markup reports a pass just as confidently as one measuring the
right markup — worth remembering when reading any row above.

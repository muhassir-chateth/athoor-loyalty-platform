# Task 30.3 — real-browser width pass

Measured in headless Chrome over CDP. 10 sections x 8 widths = 80 measurements.

## Horizontal overflow (scrollWidth > width)

**0 of 80**

## Bottom bar position — VALID (CSS applied to the real class)

The `position` column below is real evidence: it is the shipped stylesheet resolved against
`.athoor-portal__nav` by Chrome, and does not depend on how many children the element has.
`fixed` below 750, `static` at 768, `sticky` from 1024 — which is the boundary
`portalResponsivePreconditions.test.ts` declares.

The **target count and size columns are NOT valid evidence** and must not be read as a
result. See "What this could not measure" below.

## Bottom bar: fixed below 750, released at 768

| width | position | visible targets | min target h x w |
|---|---|---|---|
| 320 | fixed | 1 | 56 x 320 |
| 375 | fixed | 1 | 56 x 375 |
| 390 | fixed | 1 | 56 x 390 |
| 414 | fixed | 1 | 56 x 414 |
| 768 | static | 1 | 44 x 86 |
| 1024 | sticky | 1 | 44 x 220 |
| 1280 | sticky | 1 | 44 x 220 |
| 1920 | sticky | 1 | 44 x 220 |

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

## What this could not measure, and why

`sectionHtml()` wraps each section in the scaffold from `portal-section.liquid`, and that
scaffold's `<nav>` is a **one-item stub** — a single Overview link. The shipped navigation
lives in `portal-nav.liquid` and is a Liquid `for` loop over eight `nav_items`, so producing
it needs Liquid evaluation, which this harness does not do.

Consequences, stated plainly rather than glossed:

| 30.3 requirement | Status here |
|---|---|
| `scrollWidth <= width` per section, 8 widths | **MEASURED, 0 failures of 80** |
| bar fixed below 750, released at 750 | **MEASURED** — fixed <750, static at 768 |
| five bottom-bar targets at 320 | **NOT measured** — the fixture nav has one link, not five |
| every target >= 44px at 320 | **NOT measured** — same reason (the 56px figure describes the stub) |
| wishlist 1-up/2-up boundary at 390 | **NOT measured** — the harness selector did not match the fixture's grid element |
| no clipped text | **NOT measured** — needs per-element overflow comparison, not yet implemented |
| mobile keyboard case | **NOT measurable here** — needs a real device |
| the live storefront render | **NOT measurable here** — needs an authenticated preview session |

The three unmeasured layout boundaries are still gated **statically** by
`portalResponsivePreconditions.test.ts`, which asserts the declarations behind them (five bar
entries, the 390 boundary, the 750 release, the 44px minimum). So they are not unverified —
they are verified as declarations rather than as rendered results, which is precisely the gap
30.3 exists to close. Closing it needs a Liquid-rendered nav in the fixture.

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

---

# The remaining clauses, measured on the REAL rendered portal

Everything above this line was measured against a fixture. This section was measured against the
portal as an authenticated customer actually renders it (customer `9395357876563`, draft allowlist,
live Chrome/CDP session). That distinction is the whole point of the section: the fixture rows were
only ever evidence that the CSS *could* behave, not that the shipped markup *does*.

Eight widths, two sections, `Emulation.setDeviceMetricsOverride`, 9s settle per width.

## `my-athoor-wishlist`

| width | scrollWidth | overflow | bar position | nav targets | min target HxW | grid columns |
|---|---|---|---|---|---|---|
| 320 | 320 | none | fixed | 5 | 56x64 | **1** |
| 375 | 375 | none | fixed | 5 | 56x75 | **1** |
| 390 | 390 | none | fixed | 5 | 56x78 | **2** |
| 414 | 414 | none | fixed | 5 | 56x83 | 2 |
| 768 | 768 | none | relative | 8 | 44x67 | 3 |
| 1024 | 1024 | none | sticky | 8 | 44x220 | 2,4 |
| 1280 | 1280 | none | sticky | 8 | 44x220 | 2,4 |
| 1920 | 1920 | none | sticky | 8 | 44x220 | 2,4 |

## `my-athoor` (overview)

| width | scrollWidth | overflow | bar position | nav targets | min target HxW | grid columns |
|---|---|---|---|---|---|---|
| 320 | 320 | none | fixed | 5 | 56x64 | 3 |
| 375 | 375 | none | fixed | 5 | 56x75 | 3 |
| 390 | 390 | none | fixed | 5 | 56x78 | 3 |
| 414 | 414 | none | fixed | 5 | 56x83 | 3 |
| 768 | 768 | none | relative | 8 | 44x67 | 3,4 |
| 1024 | 1024 | none | sticky | 8 | 44x220 | 2,3,4 |
| 1280 | 1280 | none | sticky | 8 | 44x220 | 2,3,4 |
| 1920 | 1920 | none | sticky | 8 | 44x220 | 2,3,4 |

## What these rows settle

- **The 1-up/2-up wishlist boundary is exactly 390.** 320 and 375 resolve to one column; 390 resolves
  to two. The boundary is not approximately right, it is on the stated pixel.
- **No horizontal overflow at any width, either section.** `scrollWidth == clientWidth` in all 16 rows.
- **The bottom bar is `fixed` below 750 and released to `relative` at 768**, then `sticky` from 1024.
- **Tap targets: 5 below 750, 8 from 768.** Smallest is 56x64 at 320px, so the 44px floor holds with
  room to spare; the 44px-high rows at >=768 are desktop nav links, not touch targets.

## The two "clipped text" hits were false positives, and I checked rather than assumed

The detector flagged `.athoor-portal__skip` and `.athoor-portal__live` at every single width. A defect
that reproduces identically at all eight widths is usually the detector, not the CSS. Computed styles:

| element | position | clip | w x h | verdict |
|---|---|---|---|---|
| `.athoor-portal__skip` | absolute | `rect(0px, 0px, 0px, 0px)` | 1 x 1 | visually hidden by design |
| `.athoor-portal__live` | absolute | `rect(0px, 0px, 0px, 0px)` | 0 x 0 | visually hidden by design |

Both are the skip link and the ARIA live region — elements whose entire job is to be available to a
screen reader and invisible on screen. `scrollWidth > clientWidth` is the *expected* state for a
`clip: rect(0,0,0,0)` element, so my detector was measuring them wrongly, not finding a defect.
**No real clipped text at any width.** The detector needs a visually-hidden exclusion before it is
trustworthy; I have not fixed it, so treat any future clipped-text row from it with the same suspicion.

## 30.3 remaining gap

One clause is still unmeasured and cannot be measured from here: **the mobile software keyboard**
(does it occlude the bottom bar or the focused field on a real handset). That needs a physical device.
Everything else in 30.3 is now measured on the shipped markup.

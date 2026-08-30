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

## Not covered here

- The live storefront render (needs an authenticated preview session).
- The mobile-keyboard case of 30.3 (needs a real device).

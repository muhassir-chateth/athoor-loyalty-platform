# Wishlist handle resolution — captured storefront evidence

**Date:** 2026-07-27 · **Store:** `athoor-loyalty-staging.myshopify.com` (staging dev store) · **Task:** 43

First step of task 43, taken before writing any implementation: capture the
**real** transport responses from `/products/{handle}.js` so the wrapper's
three-way classification is validated against observed behaviour rather than
assumed. Access was via the storefront password session (the dev store's password
protection cannot be disabled).

## Captured responses

Requests follow redirects, mirroring `fetch`'s default `redirect: "follow"`.

| Case | Status | Redirects | Content-Type | Body | Classification |
|---|---|---|---|---|---|
| Valid handle (`the-inventory-not-tracked-snowboard`), session held | `200` | 0 | `text/javascript` | product JSON with numeric `id`, 2138 bytes | **resolved** |
| Nonexistent handle (`definitely-not-a-real-handle-46`) | `404` | 0 | `text/javascript` | **empty, 0 bytes** | 404, no redirect, no product JSON |
| Archived product (`the-archived-snowboard`, status ARCHIVED) | `404` | 0 | `text/javascript` | **empty, 0 bytes** | identical to nonexistent |
| Draft product (`the-draft-snowboard`, status DRAFT) | `404` | 0 | `text/javascript` | **empty, 0 bytes** | identical to nonexistent |
| Valid handle, **no session** (password gate) | `200` | 1 → `/password` | `text/html` | 11571 bytes of HTML | **environmental** |
| Nonexistent handle, no session | `200` | 1 → `/password` | `text/html` | 11571 bytes of HTML | **environmental** |

## What this confirmed

1. **The password gate arrives as a `200`, not a `302`,** once redirects are
   followed. A rule keyed only on "the body is not valid product JSON" would
   therefore have misclassified an environmental failure as a missing product.
   The status-plus-no-redirect condition is what prevents that.
2. **`redirect: "follow"` carries enough information.** The gate shows up as
   `response.redirected === true` with `response.url` ending in `/password`, so
   `redirect: "manual"` is not required. That transport question is settled.
3. **A genuine product 404 returns an empty body**, not a themed 404 page — so
   body fingerprinting was never going to be a reliable signal, and correctly was
   not used.

## What this changed

**A `404` is not proof of deletion.** An ARCHIVED product and a DRAFT product
return a response byte-for-byte identical to a handle that never existed: `404`,
zero bytes, no redirect, `text/javascript`. The storefront exposes no way to tell
"deleted" from "temporarily unpublished".

The previously agreed rule — prune on a genuine `404` with no redirect and no
valid product JSON — would therefore have **permanently deleted a member's
wishlist entry for a product that still exists.** For a fragrance house running
limited editions and seasonal returns, the products most likely to be temporarily
unpublished are exactly the ones a member most wants saved.

**Decision (owner, 2026-07-27): never prune.** Unresolved handles stay in
`localStorage` and are simply excluded from the reconcile payload. The cost is a
repeat lookup on a path that runs rarely; the alternative is irreversible loss of
member data on ambiguous evidence. This keeps the one-way failure model intact —
data is discarded only on unambiguous evidence, and staging demonstrated that a
`404` does not qualify.

A consequence worth recording: because nothing is ever pruned, a handle for a
genuinely deleted product remains in the device list indefinitely and is retried
each session. That is accepted as the cheaper failure.

## Reproducing

With a storefront session established against `/password`, request
`/products/{handle}.js` and record final status, redirect count, content type, and
whether the body parses as JSON with a numeric `id`. Handles used above exist on
the staging dev store; ARCHIVED and DRAFT examples are part of Shopify's standard
dev-store seed catalogue.

# Task 30.2 — the authenticated journey pass

Task 30.1 is complete: the 28 portal files are on production theme `205900054867`
(unpublished), verified byte-identical, and the portal is dark. This document is what
30.2 needs, why part of it cannot be automated here, and the exact steps to run it.

---

## 1. Why this is an operator pass, not a test run

Requirement **26.8** says the journey runs "in a real rendered browser", and **26.9**
says "a jsdom result is insufficient evidence for final journey verification". Three
things follow, each verified rather than assumed:

**No browser automation exists in this repository.** `package.json` has no Playwright,
Puppeteer, Cypress, Selenium or WebDriver — only `jsdom@26.1.0`, which 26.9 excludes.

**Adding one would break a release gate.** Task 29.10 (Requirements 19.2, 19.8, 19.10)
asserts `npm ls --omit=dev` is byte-identical to the pre-portal tree except for exactly
two pinned devDependencies, `esbuild` and `axe-core`. Installing a browser driver fails
that gate, and it also collides with the `NEW RECURRING COST = £0/MONTH` constraint in
task 33. That gate should not be weakened to make 30.2 pass.

**Customer authentication cannot be automated from here at all.** `/account/login`
redirects to `https://shopify.com/95446139219/account` — Shopify-hosted **new customer
accounts** (Branch B, now confirmed empirically). That flow is passwordless: the
customer receives a one-time code by email. There is no password to supply, and **no
Admin API scope grants the ability to sign in as a customer** — Admin scopes govern the
Admin API, which is a different axis entirely. Multipass would bypass it, but Multipass
requires Shopify Plus and this store is on the **Basic** plan.

Together with **26.10** ("no production customer, no production order, no production
redemption" may be created), 30.2 is necessarily executed by a person who can receive
the login codes. That matches how 30.4 is already written — "record the manual checklist
for the release".

---

## 2. Preconditions, in order

### 2a. The ten Pages must exist — currently they do not

Verified after the 30.1 push: `/pages/my-athoor?preview_theme_id=205900054867` returns
**404**, while `/pages/rewards` returns 200. The templates are on the theme; the Page
resources are not in the store.

**No API scope is strictly required.** Create them in Shopify admin → Online Store →
Pages → **Add page**. For each: set the handle, set **Theme template** to the matching
template, and set visibility to **Hidden**.

| Page handle (set in the URL field) | Theme template | Suggested title |
|---|---|---|
| `my-athoor` | `my-athoor` | My Athoor |
| `my-athoor-orders` | `my-athoor-orders` | My Athoor — orders |
| `my-athoor-order-detail` | `my-athoor-order-detail` | My Athoor — order detail |
| `my-athoor-wishlist` | `my-athoor-wishlist` | My Athoor — wishlist |
| `my-athoor-rewards` | `my-athoor-rewards` | My Athoor — rewards |
| `my-athoor-activity` | `my-athoor-activity` | My Athoor — activity |
| `my-athoor-referrals` | `my-athoor-referrals` | My Athoor — referrals |
| `my-athoor-profile` | `my-athoor-profile` | My Athoor — profile |
| `my-athoor-fragrance` | `my-athoor-fragrance` | My Athoor — fragrance |
| `my-athoor-settings` | `my-athoor-settings` | My Athoor — settings |

**Create them Hidden.** A Page is store data shared by every theme. A *published* Page
whose template the **live** theme does not have falls back to `templates/page.liquid`
and renders as an ordinary near-empty page — ten thin, indexable URLs appearing on the
production storefront before the portal ships. Publishing belongs to 31.6's staged flip.

Getting a template suffix wrong fails **silently**: the page renders, just without the
portal. So verify afterwards:

```bash
# needs read_content only — read-only, changes nothing
SHOPIFY_THEME_TOKEN=… npm run theme:pages -- \
  --store=myathoorlondon.myshopify.com --environment=production \
  --confirm-production-store=myathoorlondon.myshopify.com
```

It reports, per handle: missing, wrong template, or published-when-it-should-be-hidden.
With `--create --confirm-create` it will create the missing ones itself, hidden — that
needs `write_content`.

### 2b. The portal must be switched on, on the preview theme only

This is the gap flagged in `portal-production-readiness.md` §3. The 30.1 push was
correctly limited to the portal's own **new** files, so the preview theme's
`config/settings_schema.json` does not declare `portal_enabled` — both settings resolve
to `nil`, and `portal_on` can never become true. **The portal cannot be turned on on
that theme as it stands, so 30.2 has nothing to exercise yet.**

Closing it needs two edits to the **preview** theme, both to files that already exist
there (so both are modifications, which is why they were not in 30.1):

1. `config/settings_schema.json` — add the "My Athoor Portal" group, exactly as it
   exists in this repository at `theme/config/settings_schema.json`.
2. Then in the theme editor for `205900054867` → Theme settings → My Athoor Portal, put
   **your own customer id** in *Staged rollout: customer IDs* and leave "Show the My
   Athoor portal to everyone" **off**.

Using the allowlist rather than the global switch keeps the blast radius at one
customer even on the preview theme, and it exercises the same code path 31.6 will use.

**Do not make either edit on the live theme `180956594515`.**

### 2c. The migrations must be applied — still unverified

30.1's criteria require migrations to precede the push; that did not gate 30.1 because
a dark portal executes no route. **It does gate 30.2**, because the journey will call
every endpoint for real. Six of the seven post-RC1 migrations create the tables the
portal reads, so a missing one produces a 500 on the section that needs it.

Run the SQL in `portal-production-readiness.md` §5 first and confirm 7 applied / 22
total. `/health` cannot answer this — it exposes no schema state.

---

## 3. The eight customer profiles, without creating any

26.2 requires: a new customer, one with no orders, one with orders, one with no loyalty
activity, one with activity, one with a wishlist, one with referrals, and one with
substantial history. 26.10 forbids creating production customers.

These must therefore be **existing** customers whose login codes you can receive. One
account cannot cover "new customer" and "substantial history" at once, so plan which
real accounts cover which rows, and record the mapping — a row covered by an account
that does not actually have that data shape is not covered.

Where a profile has no real account behind it, say so in the record rather than marking
it passed. An honest gap is auditable; a false pass is not.

---

## 4. The journey

For each profile, with the preview theme and your customer id in the allowlist. Every
URL takes `?preview_theme_id=205900054867`.

| # | Step | Assert |
|---|---|---|
| 1 | Sign in via `/account` | Redirected back; portal visible because your id is allowlisted |
| 2 | `/pages/my-athoor` | Greeting, points numeral, tier, no `loading` state left behind |
| 3 | `/pages/my-athoor-profile` | Fields populated; save a change; reload shows it persisted |
| 4 | `/pages/my-athoor-orders` | Orders listed, or a true empty state for the no-orders profile |
| 5 | Open one order | Order number, totals, delivery address, line items |
| 6 | `/pages/my-athoor-wishlist` | Items render; remove one; reload shows removal persisted |
| 7 | `/pages/my-athoor-rewards` | Balance, tier, catalogue. **Do not redeem** — 26.10 |
| 8 | `/pages/my-athoor-activity` | Ledger rows, or a true empty state |
| 9 | `/pages/my-athoor-referrals` | Code and share link present; link is well-formed |
| 10 | Birthday, in profile or settings | Set once; reload persists; second change refused if locked |
| 11 | `/pages/my-athoor-settings` | Preferences toggle and persist |
| 12 | Sign out | Portal no longer renders; no customer data in the page source |
| 13 | Sign back in | Everything from steps 3, 6, 10 and 11 still persisted |

Record per step: profile, step, pass/fail, and for any failure the `x-request-id` from
the network tab — it identifies the exact server-side request and is what makes a
failure diagnosable afterwards.

**Two things to watch that the automated suite cannot see.** A section stuck on
`loading` forever is the failure mode PR #28 fixed (a `null` body resolved as success,
so `paintBirthday` threw after the boot boundary and all ten sections hung). And any
section rendering another customer's data is a Property 1 violation — stop the pass
immediately if seen.

---

## 5. What must not happen

- The theme must not be published. `205900054867` stays `role: unpublished`.
- Live theme `180956594515` must not be modified. It is currently 388 assets, 0 portal
  assets, key-list SHA-256 `2b45b1bc0987b1fd`; re-check that after the pass.
- No customer, order or redemption created (26.10).
- The Pages stay **Hidden** until 31.6.
- `settings.portal_enabled` stays **off**; use the allowlist.

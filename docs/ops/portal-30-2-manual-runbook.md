# Task 30.2 — manual runbook

Everything needed to run the 30.2 journey without any new Shopify credential.
Derived from the repository at the commit this document ships in; nothing guessed.

**Fixed state, for reference**

| | |
|---|---|
| Store | `myathoorlondon.myshopify.com` (primary domain `myathoorlondon.co.uk`) |
| Live theme | `180956594515` — **never modify, never publish against** |
| Preview theme | `205900054867` "Copy of My Athoor London", `role: unpublished` |
| 30.1 | complete and verified — 28 files, byte-identical, portal dark |
| App Proxy prefix | `/apps/loyalty` |

---

## 1. The ten Page objects

Derived from `theme/templates/page.my-athoor*.liquid`. The handle **is** the template
suffix — that is the whole contract, and `src/theme/portalRouteContract.test.ts` fixes
it from the theme side.

| # | Liquid template file | Template suffix | Page handle | Recommended title | Content |
|---|---|---|---|---|---|
| 1 | `page.my-athoor.liquid` | `my-athoor` | `my-athoor` | My Athoor | **blank** |
| 2 | `page.my-athoor-orders.liquid` | `my-athoor-orders` | `my-athoor-orders` | My Athoor — Your orders | **blank** |
| 3 | `page.my-athoor-order-detail.liquid` | `my-athoor-order-detail` | `my-athoor-order-detail` | My Athoor — Your order | **blank** |
| 4 | `page.my-athoor-wishlist.liquid` | `my-athoor-wishlist` | `my-athoor-wishlist` | My Athoor — Your wishlist | **blank** |
| 5 | `page.my-athoor-rewards.liquid` | `my-athoor-rewards` | `my-athoor-rewards` | My Athoor — Rewards | **blank** |
| 6 | `page.my-athoor-activity.liquid` | `my-athoor-activity` | `my-athoor-activity` | My Athoor — Points activity | **blank** |
| 7 | `page.my-athoor-referrals.liquid` | `my-athoor-referrals` | `my-athoor-referrals` | My Athoor — Referrals | **blank** |
| 8 | `page.my-athoor-profile.liquid` | `my-athoor-profile` | `my-athoor-profile` | My Athoor — Profile | **blank** |
| 9 | `page.my-athoor-fragrance.liquid` | `my-athoor-fragrance` | `my-athoor-fragrance` | My Athoor — Fragrance profile | **blank** |
| 10 | `page.my-athoor-settings.liquid` | `my-athoor-settings` | `my-athoor-settings` | My Athoor — Settings | **blank** |

### Why the content must be blank, and why the title barely matters

No portal template reads `page.title` or `page.content`. Each one passes its heading
**explicitly** to `portal-chrome` — for example `page.my-athoor-orders.liquid` passes
`page_title: 'Your orders'`. So:

- **The Shopify Page title never appears in the portal UI.** It is an admin-facing
  label only. The titles above are recommendations for finding them in the admin list;
  the portal headings are fixed in the templates and are the third column of §7.
- **Content must be blank.** With the flag **off**, `portal-chrome` renders
  `{{ page.content }}` and nothing else — that is what makes a flag-off response a
  plain Shopify page (Requirement 22.2). Anything typed into the body would become
  visible on the storefront while the portal is dark. With the flag **on**, the content
  is never rendered at all.

Blank content plus **Hidden** visibility is therefore the only combination that is
correct in both flag states.

### The portal headings, for cross-checking during the journey

| Handle | Heading the page must show | Section id | Nav item highlighted |
|---|---|---|---|
| `my-athoor` | Overview | `overview` | overview |
| `my-athoor-orders` | Your orders | `orders` | orders |
| `my-athoor-order-detail` | Your order | `order-detail` | **orders** |
| `my-athoor-wishlist` | Your wishlist | `wishlist` | wishlist |
| `my-athoor-rewards` | Rewards | `rewards` | rewards |
| `my-athoor-activity` | Points activity | `activity` | **rewards** |
| `my-athoor-referrals` | Referrals | `referrals` | referrals |
| `my-athoor-profile` | Profile | `profile` | profile |
| `my-athoor-fragrance` | Fragrance profile | `fragrance` | fragrance |
| `my-athoor-settings` | Settings | `settings` | settings |

The two bold rows are deliberate: order detail and points activity are sub-views, so
they highlight their parent nav item rather than themselves. If order detail highlights
nothing, that is a defect.

---

## 2. Creating the ten Pages by hand

> **STATUS: done, and not by hand.** All ten Pages exist with the correct
> `template_suffix`, all `published_at = null` (Hidden), no duplicates. Because the
> **Theme template** dropdown enumerates the *published* theme (confirmed below), the
> suffixes were set through the Admin API instead — ten single-field `PUT`s, exactly the
> minimum shape described later in this section. Page ids:
> `my-athoor` 182286549331 · `-orders` 182382494035 · `-order-detail` 182382461267 ·
> `-wishlist` 182382657875 · `-rewards` 182382592339 · `-activity` 182382395731 ·
> `-referrals` 182382559571 · `-profile` 182382526803 · `-fragrance` 182382428499 ·
> `-settings` 182382625107. Titles were left as the lowercase handle: no template reads
> `page.title`, so it is an admin-facing label only.

For each row in §1, in Shopify admin:

1. **Online Store → Pages → Add page**
2. **Title** — from the table.
3. Leave the **content** body completely **empty**.
4. Open **Search engine listing** (or the URL/handle field) and set the **URL handle**
   to the exact handle from the table. Shopify will otherwise derive a handle from the
   title, which would produce `my-athoor-your-orders` and a 404.
5. In the right-hand sidebar, **Theme template** → select the matching suffix.
6. Set visibility to **Hidden** (not Visible, not scheduled).
7. **Save.**

**Handle accuracy is the thing to be careful about.** Shopify silently de-duplicates: if
`my-athoor` already exists, a second attempt becomes `my-athoor-1`, which 404s. After
saving each page, confirm the handle field reads exactly what the table says.

### CONFIRMED: the template is not selectable, and why

Shopify's **Theme template** dropdown lists templates from the **published** theme. The
ten `page.my-athoor*` templates exist **only on the unpublished preview theme
`205900054867`** — that is exactly what 30.1 was for.

This was checked on the live store (Online Store → Pages → an existing page → Theme
template). The dropdown offered exactly twelve entries:

```
Default page, about, account-landing, compare, contact, faq,
fragrances, loyalty, rewards, service, travel-sets, wishlist
```

That is a **byte-for-byte match** with the repository's twelve *non-portal* page
templates, and **none** of the ten `my-athoor*` templates appear. So the cause is
established rather than inferred: the dropdown enumerates the live theme, and these ten
templates are not in it. It is not a permissions, caching or naming problem.

### The `?view=` mechanism — verified on this store

Shopify honours a `view` query parameter that selects an alternate template **at request
time, with no `template_suffix` involved**. Confirmed against the live storefront with
read-only GETs:

| URL | bytes | `loyalty-dashboard` | `dtx-wishlist` |
|---|---|---|---|
| `/pages/rewards` | 301,260 | 2 | 0 |
| `/pages/rewards?view=compare` | 301,595 | **0** | **2** |
| `/pages/rewards?view=wishlist` | 304,122 | 0 | 0 |

Different views produced materially different HTML, so the parameter is honoured here.

**Consequence: 30.2's journey does not need `template_suffix` at all.** With the ten
Pages created manually (handle, blank body, Hidden, template left as *Default page*),
every portal section is reachable as:

```
/pages/<handle>?view=<suffix>&preview_theme_id=205900054867
```

What this covers, and what it does not:

- **Covered** — authentication, every section rendering, all data, all persistence,
  logout and re-authentication. The substance of Requirements 26.1 and 26.2.
- **Not covered** — *clicking* between sections. The portal's nav links point at bare
  `/pages/my-athoor-orders`, so without `template_suffix` a nav click lands on the empty
  default template. Nav *correctness* is still verifiable (`portalRouteContract.test.ts`
  asserts every href has a matching template, and the hrefs are readable in the rendered
  page); it is nav *traversal* that defers to 31.5.

**Caveat.** A non-existent view falls back silently rather than erroring —
`?view=does-not-exist-xyz` returned HTTP 200 with a different body again. So a typo does
not announce itself. Confirm each page shows its expected heading from the §1 headings
table; that heading is what distinguishes the right template from a fallback.

`?view=` carries no live risk: the live theme has none of these templates, so
`?view=my-athoor-orders` against live simply falls back to a normal page.

### What `template_suffix` is still needed for, and the exact scope

Neither publishing the preview theme nor copying templates into the live theme is on the
table: the first puts the portal's theme live ahead of tasks 31.1–31.4 (backups, scoped
diff, owner approval), and the second is 31.4's own job.

So `template_suffix` can only be set through the Admin API, and **`write_content` is the
only scope that permits it** — Shopify names the read half itself in the 403
(`requires merchant approval for read_content scope`), and write scopes subsume read, so
one scope covers both setting and verifying. No theme, customer, order or product scope
is involved.

What it buys, beyond what `?view=` already gives: nav traversal between sections, and
journey URLs identical to production. What it costs: one scope covering pages, blogs and
articles.

The **minimum** shape of the operation — the owner creates the Pages manually, so the
API only ever writes one field on ten known ids:

```
GET /admin/api/2024-10/pages.json?fields=id,handle,template_suffix,published_at
PUT /admin/api/2024-10/pages/{id}.json
    {"page": {"id": <id>, "template_suffix": "<suffix>"}}
```

Ten `PUT`s, one field each. No title, body, handle or visibility touched; no page
created or deleted; nothing outside those ten ids; no blog or article touched.

Deferring instead until 31.4 has pushed the templates to live would make the dropdown
work, but it runs 30.2's journey *after* the portal reaches the live theme, which
Requirement 26.8 explicitly does not allow ("before the portal reaches the live theme").
Recorded for completeness; not recommended.

---

## 3. No scope is being requested for creation

`read_content` and `write_content` are **not** needed for anything in §2 if the dropdown
shows the templates. Nothing in this runbook performs an API write.

---

## 4. If verification later needs `read_content` — exactly why, and for what

> **STATUS: granted.** `read_content`, `write_content`, `read_online_store_pages` and
> `write_online_store_pages` are on the app token (15 scopes total), so
> `npm run theme:pages` performs this check automatically. Last run: all ten handles
> present, all ten suffixes correct, all ten Hidden, no duplicates.

Once you have created the ten Pages, the questions that matter are:

1. Does each Page have the **exact** handle? (a wrong handle → 404)
2. Does each Page carry the **exact** `template_suffix`? (a wrong suffix → the page
   renders, **without the portal** — a silent failure)
3. Is each Page **Hidden**? (a published Page whose template the live theme lacks falls
   back to `page.liquid` and becomes a thin indexable URL on the live storefront)

You can check all three by hand: open each page and read the handle, the template and
the visibility. Ten pages, three fields each.

The single operation that would let me check it instead is:

```
GET /admin/api/2024-10/pages.json?fields=id,handle,title,template_suffix,published_at
```

That is **read-only**, returns those five fields, and requires exactly **`read_content`**
— Shopify names it itself: `403 "[API] This action requires merchant approval for
read_content scope"`. `npm run theme:pages` already implements this and reports
missing / wrong-template / wrongly-published per handle.

**I am not requesting it.** Manual checking is sufficient and costs one scope less. The
argument for granting it is only that item 2 fails silently, so a human check can pass a
page that is subtly wrong.

---

## 5. Enabling `portal_on` on the preview theme only

### The current situation — DONE, no longer manual

**This whole section is now historical.** It described a theme whose
`config/settings_schema.json` did not declare `portal_enabled` or `portal_allowlist`.
That is no longer the state. Verified against theme `205900054867` by Admin API read:

| | |
|---|---|
| `settings_schema.json` | **23** groups, including `My Athoor Portal` — declares `portal_enabled` (checkbox, default `false`) and `portal_allowlist` (textarea) |
| `settings_data.json` | `portal_enabled = false`, `portal_allowlist = "9395357876563"`, 141 settings |
| Applied by | `npm run theme:settings … --allowlist=9395357876563 --disable-portal-flag --apply` (PR #48), status `values_applied_verified` |
| Live theme | unaffected — 388 assets, key-list `2b45b1bc0987b1fd`, 0 portal assets, and its `settings_data.json` does not mention `portal_enabled` at all |

So the manual **Edit code** append and the **Customize** step below are both already
done and need not be repeated.

**Why this matters more than a stale paragraph.** The theme was found with
`portal_enabled = true` and **no** allowlist — the exact inverse of what this section
prescribes ("Leave *Show the My Athoor portal to everyone* **OFF**. Put your own numeric
customer id in *Staged rollout: customer IDs*"). The gate in `portal-chrome.liquid` reads
`if portal_enabled … elsif portal_allowlist`, so `portal_enabled` is a MASTER SWITCH that
short-circuits the allowlist: while it was on, every signed-in customer was admitted and
the allowlist governed nothing. Nothing was exposed — the theme is unpublished and the
live theme carries no portal files — but published in that state the portal would have
released to all signed-in customers at once. It has been set back to what this section
asks for. Pre-change state is backed up at
`backups/theme-205900054867-settings/2026-08-30T21-02-54-517Z/settings_data.json`.

### The narrowest change that works

Exactly **one file on exactly one theme**:

| | |
|---|---|
| Theme | `205900054867` (preview, unpublished) — **not** `180956594515` |
| File / key | `config/settings_schema.json` |
| Old value | a JSON array of **22** setting groups, with **no** group named "My Athoor Portal" |
| New value | the same array with **one group appended**, making **23** — verbatim below |
| Why | `portal-chrome.liquid` reads `settings.portal_enabled` and `settings.portal_allowlist`. Undeclared settings are `nil`, and Liquid treats `nil == blank` as true, so neither the flag branch nor the allowlist branch can ever fire. Without this, 30.2 has nothing to exercise. |
| Live theme | **unaffected** — a theme's `config/` is per-theme data. Editing the preview theme's copy cannot change the live theme's copy. Confirm with §9's check: live stays 388 assets / 0 portal / key-list `2b45b1bc0987b1fd`. |
| Rollback | delete the appended group and save. One edit, fully reversible, nothing else in the file is touched. |

Append this as the **last element** of the array in the preview theme's
`config/settings_schema.json` (put a comma after the previous `}` that closes the
"cart" group):

```json
  {
    "name": "My Athoor Portal",
    "settings": [
      {
        "type": "header",
        "content": "Customer experience portal"
      },
      {
        "type": "paragraph",
        "content": "The portal is deployed but hidden until this is switched on. With it off, every page renders exactly as it does today and no portal markup, stylesheet or script is emitted."
      },
      {
        "type": "checkbox",
        "id": "portal_enabled",
        "default": false,
        "label": "Show the My Athoor portal to everyone",
        "info": "Turn on to release the portal to all signed-in customers. Leave off to keep using the allowlist below for a staged rollout."
      },
      {
        "type": "textarea",
        "id": "portal_allowlist",
        "label": "Staged rollout: customer IDs",
        "info": "Comma-separated numeric customer IDs. These customers see the portal while it is still hidden from everyone else. Ignored once the switch above is on."
      }
    ]
  }
```

This is byte-for-byte the group already in the repository at
`theme/config/settings_schema.json`, so the preview theme ends up matching what 31.2
will later apply to live.

**How to apply it, no credential required:** Shopify admin → Online Store → Themes →
find "Copy of My Athoor London" → **⋯ → Edit code** → `config/settings_schema.json` →
append the group → **Save**. Shopify validates the JSON on save, so a malformed paste is
rejected rather than silently breaking the theme.

### Then switch it on for one customer only

Themes → "Copy of My Athoor London" → **Customize** → **Theme settings** → **My Athoor
Portal**:

- Leave **"Show the My Athoor portal to everyone"** **OFF**.
- Put **your own numeric customer id** in **"Staged rollout: customer IDs"**.
- Save.

Use the allowlist rather than the global switch for two reasons: the blast radius stays
at one customer even if the preview link is shared, and it exercises the same code path
31.6 will use for the real staged rollout, so the rollout mechanism is tested rather than
merely assumed.

Your numeric customer id is in the admin URL when you open your own customer record:
`admin/customers/<id>` — that number, digits only.

**Note on `settings_data.json`.** The Customize step above writes it for you. A
theoretically narrower route is to set the value directly in
`config/settings_data.json` without touching the schema at all — but whether Liquid
exposes a `settings` key that the schema does not declare is version-dependent and I
have **not** verified it on this store. It is recorded only so nobody relies on it.

---

## 6. Migration verification SQL — read-only

Verbatim from `docs/ops/portal-production-readiness.md` §5. Checked mechanically before
publishing here: **four `SELECT` statements and nothing else** — no `INSERT`, `UPDATE`,
`DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT` or `REVOKE`.

```sql
-- 1. Are all 7 post-RC1 migrations recorded as applied?  EXPECT 7 rows.
SELECT name, run_on
  FROM pgmigrations
 WHERE name IN ('1785950000000_harden-data-api-exposure',
                '1786000000000_create-customer-birthdays',
                '1786100000000_create-fragrance-preferences',
                '1786200000000_create-communication-preferences',
                '1786300000000_create-erasure-requests',
                '1786500000000_create-wishlist-removals',
                '1786600000000_extend-audit-for-redaction')
 ORDER BY name;

-- 2. Total applied count, to detect a partial deploy.  EXPECT 22.
SELECT count(*) AS applied FROM pgmigrations;

-- 3. Do the tables those migrations create actually exist?  EXPECT present = true for all 9.
SELECT t.relname AS table_name,
       to_regclass('public.' || t.relname) IS NOT NULL AS present
  FROM (VALUES ('customer_birthdays'),
               ('birthday_grants'),
               ('customer_fragrance_preferences'),
               ('customer_communication_preferences'),
               ('customer_erasure_requests'),
               ('customer_wishlist_removals'),
               ('security_baseline_grants'),
               ('security_baseline_rls'),
               ('security_baseline_default_acl')) AS t(relname)
 ORDER BY 1;

-- 4. Did migration 22 widen the audit CHECK constraint?
--    EXPECT a definition listing the redaction operation types.
SELECT pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname = 'admin_audit_log_operation_type_check';
```

**Which section breaks if a migration is missing**, so a failure maps to a symptom:

| Missing migration | Section that fails |
|---|---|
| `1786000000000_create-customer-birthdays` | Birthday (in Profile / Overview) |
| `1786100000000_create-fragrance-preferences` | Fragrance profile |
| `1786200000000_create-communication-preferences` | Settings (preferences) |
| `1786300000000_create-erasure-requests` | Settings (erasure request) |
| `1786500000000_create-wishlist-removals` | Wishlist (removals) |
| `1786600000000_extend-audit-for-redaction` | admin audit writes on redaction paths |
| `1785950000000_harden-data-api-exposure` | data-API exposure posture (not a portal section) |

---

## 7. The journey — URLs, templates and expected API calls

Every URL takes `?preview_theme_id=205900054867`. All API paths are relative to the App
Proxy prefix `/apps/loyalty`.

| # | URL | Template | Expected API calls |
|---|---|---|---|
| 1 | `/pages/my-athoor` | `page.my-athoor` | `GET /balance`, `/profile`, `/orders`, `/profile/wishlist`, `/profile/birthday`, `/referral`, `/catalog/products` |
| 2 | `/pages/my-athoor-profile` | `page.my-athoor-profile` | `GET`+`PUT /profile/identity`, `/profile/addresses` (`POST`/`PUT`/`DELETE`), `/profile/birthday`, `/profile/preferences` |
| 3 | `/pages/my-athoor-orders` | `page.my-athoor-orders` | `GET /orders` |
| 4 | `/pages/my-athoor-order-detail?id=<numeric>` | `page.my-athoor-order-detail` | order detail + `POST` buy-again |
| 5 | `/pages/my-athoor-wishlist` | `page.my-athoor-wishlist` | `GET`+`PUT /profile/wishlist`, `GET /catalog/products` |
| 6 | `/pages/my-athoor-rewards` | `page.my-athoor-rewards` | `GET /balance`, `/redemptions` — **`POST /redeem` must NOT be exercised** |
| 7 | `/pages/my-athoor-activity` | `page.my-athoor-activity` | `GET /history`, `/rewards` |
| 8 | `/pages/my-athoor-referrals` | `page.my-athoor-referrals` | `GET /referral`, `POST /referral` (claim) |
| 9 | `/pages/my-athoor-fragrance` | `page.my-athoor-fragrance` | `GET`+`PUT /profile/preferences`, `GET /profile`, `/catalog/products` |
| 10 | `/pages/my-athoor-settings` | `page.my-athoor-settings` | `GET`+`PUT /profile/preferences`, `/profile/consent`, `/profile/addresses` — **`/profile/erasure-request` and `/profile/export` must NOT be submitted** |

`order-detail` takes the order id as a **query parameter**, validated server-side
against `^\d{1,20}$` (§6.3 N2). A Shopify page template cannot own a path segment.

### Three things that must not be triggered

- **`POST /redeem`** (Rewards) — Requirement 26.10 forbids creating a production
  redemption. View the catalogue; do not press the redeem control.
- **`POST /profile/erasure-request`** (Settings) — this begins a **GDPR erasure of a real
  customer's data**. Do not submit it. Confirm the control exists and stop.
- **`POST /profile/export`** (Settings) — generates a personal-data export. Harmless but
  pointless here; skip it.

Address **delete** in Profile is destructive to real customer data. Prefer adding a
throwaway address and deleting only that one, or skip the delete path entirely and note
it as uncovered.

---

## 8. Customer login prerequisites

`/account/login` on this store redirects to `https://shopify.com/95446139219/account` —
Shopify-hosted **new customer accounts** (Branch B, confirmed empirically). That flow is
**passwordless**: the customer enters an email address and Shopify emails a one-time
code. There is no password field.

Consequences for this pass:

- You need **access to the email inbox** of every account you test. No Shopify API scope
  grants the ability to sign in as a customer — Admin scopes govern the Admin API, a
  different axis. Multipass would, but requires Shopify Plus and this store is **Basic**.
- Requirement 26.10 forbids creating production customers, so the profiles below must be
  **existing** accounts.
- Each account you want the portal visible for must have its **numeric customer id** in
  the preview theme's allowlist (§5).

### The eight profiles

Requirement 26.2 lists eight. Map each to a real account and record the mapping; a row
covered by an account that does not actually have that data shape is **not covered**.

| # | Profile required | Account used | Confirmed has this shape? |
|---|---|---|---|
| 1 | new customer | | |
| 2 | no orders | | |
| 3 | has orders | | |
| 4 | no loyalty activity | | |
| 5 | has loyalty activity | | |
| 6 | has a wishlist | | |
| 7 | has referrals | | |
| 8 | substantial history | | |

One account cannot be both "new" and "substantial history", so expect to need several.
**Where no real account fits a row, write "not covered" rather than marking it passed.**
An honest gap is auditable; a false pass is not, and 30.2 is a release gate.

---

## 9. Assertions, per step

Run this for each profile. `?preview_theme_id=205900054867` on every URL.

### PREREQUISITE — read this before step 1, or step 1 will fail

**The ten Pages are Hidden, and a Hidden page returns 404 on the storefront regardless
of which theme is previewing.** Verified with read-only GETs:

| Request | Result |
|---|---|
| `/pages/my-athoor` | **HTTP 404** |
| `/pages/my-athoor?preview_theme_id=205900054867` | **HTTP 302** → `location: /pages/my-athoor`, param stripped, only `_shopify_essential` set → follows to **HTTP 404** |

A bare `preview_theme_id` does not establish a preview for an unauthenticated visitor —
Shopify discards it. And page publication state is independent of theme preview, so an
authenticated storefront **Preview** session is expected to 404 on these pages too.
Making them Visible is not an option: a published Page whose template the live theme
lacks falls back to `page.liquid` and becomes a thin indexable URL on the live store.

**Two ways to actually start the journey, neither of which publishes anything:**

1. **Theme editor** (Themes → "Copy of My Athoor London" → **Customize**). This renders
   in an authenticated admin iframe and is the one context expected to display an
   unpublished page. Try this first; it costs nothing.
2. **`?view=` on a page that is already Visible** — the mechanism §2 already established
   on this store. In an authenticated preview session,
   `/pages/rewards?view=my-athoor-orders` renders the portal template without any portal
   Page needing to be public. This covers authentication, every section's rendering, all
   data and all persistence; it does **not** cover nav *traversal*, which defers to 31.5.
   Confirm the expected heading from the §1 headings table, because a bad `view` falls
   back silently with HTTP 200.

### Also before you start: the allowlisted customer has no orders

Customer `9395357876563` is real and `state: enabled`, but `orders_count = 0`. So step 4
will legitimately show the **empty** state and step 5 cannot be reached by clicking a
row, because there are no rows. To exercise order detail — and the PR #47 fix to the
order-row link — either use an account that has orders and add its id to the allowlist,
or open `/pages/my-athoor-order-detail?id=<a real order id>` directly.

| # | Step | Assert |
|---|---|---|
| 1 | Sign in at `/account` | Signed in; portal renders because your id is allowlisted |
| 2 | Overview | Greeting, points numeral, tier; **no section left showing `loading`** |
| 3 | Profile | Fields populated; change one; reload → persisted |
| 4 | Orders | Orders listed most-recent-first, or a true empty state |
| 5 | Order detail | Heading "Your order", order number, totals, delivery address, line items |
| 6 | Wishlist | Items render; remove one; reload → removal persisted |
| 7 | Rewards | Balance, tier, catalogue. **Do not redeem** |
| 8 | Points activity | Ledger rows or a true empty state; nav highlights **Rewards** |
| 9 | Referrals | Code shown; share link well-formed and copyable |
| 10 | Birthday | Set once; reload → persisted; a second change refused if locked |
| 11 | Settings | Preferences toggle and persist. **Do not submit erasure or export** |
| 12 | Sign out | Portal no longer renders; **no customer data anywhere in page source** |
| 13 | Sign back in | Steps 3, 6, 10, 11 changes all still persisted |

### Two failure modes the automated suite cannot see

- **A section stuck on `loading` forever.** This is the defect PR #28 fixed: a `null`
  body was resolved as success, so a paint function threw *after* the boot boundary had
  already returned, and all ten sections hung. It looks like slowness, not an error.
- **Any section showing another customer's data.** That is a Property 1 violation. Stop
  the pass immediately, record the `x-request-id`, and do not continue.

### Cross-check the eight widths while you are there (task 30.3)

At 320, 375, 390, 414, 768, 1024, 1280 and 1920 CSS pixels: no horizontal scrollbar, no
clipped text, five bottom-bar targets at 320, the wishlist going 1-up → 2-up at exactly
390, and the bottom bar releasing at 768. The declarations behind those numbers are
already gated by `src/theme/portalResponsivePreconditions.test.ts`; this pass confirms
the rendered result.

---

## 10. Evidence to record

For each profile:

- A screenshot of each of the ten pages in its **ready** state (not loading).
- A screenshot of each **empty** state you legitimately hit.
- For **every** failure: the `x-request-id` response header from the network tab. Every
  response carries one (12 lowercase letters, added in PR #30); it identifies the exact
  server-side request and is what makes a failure diagnosable afterwards.
- The completed §8 profile table, including "not covered" rows.
- The completed §9 assertion table per profile.
- Browser and OS versions, and the device or emulation used for each width.

Afterwards, confirm the live theme was untouched throughout:

```bash
# expect: 388 assets, 0 portal assets, key-list 2b45b1bc0987b1fd
```

and that theme `205900054867` is still `role: unpublished`.

---

## 11. What is still not covered by this runbook

- **30.4** needs VoiceOver on iOS Safari and NVDA on Windows Firefox. Genuinely manual,
  genuinely device-dependent.
- **30.5** needs Lighthouse, three runs, median, per section, mobile and desktop, against
  the Production_Performance_Baseline. A section whose measured LCP or CLS exceeds its
  baseline does not ship.
- **30.6** compares preview and live rendered HTML for the regions that must not change.
  Partly doable now: with the flag **off**, the preview homepage already renders
  byte-identically in size to live (391,183 bytes each, zero portal markers on either),
  which is the first half of that comparison.

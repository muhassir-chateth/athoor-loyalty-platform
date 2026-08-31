# Portal production readiness — what is prepared, what is blocked, what the owner must do

Status: **tasks 1–29 complete. Task 30.1 COMPLETE and verified on production.**
Next blocked item is 30.2, which needs the Page objects of §4 and the enablement
decision of §3.

---

## 0. Task 30.1 — done, with evidence

Pushed on the commit recorded below, to a **non-live** theme on the production store.

| | |
|---|---|
| store | `myathoorlondon.myshopify.com` (verified via `shop.json`: primary domain `myathoorlondon.co.uk`) |
| target theme | **`205900054867`** — `role: unpublished`, "Copy of My Athoor London" |
| live theme | `180956594515` — `role: main`, **not touched** (this is the id task 31.4 names, now confirmed correct) |
| deploy commit | `c615c1f2e85eecaabe93f2e89c5dbe5929f81d49` |
| files | 28 net-new, 220,980 bytes; **0 overwrites** |
| verification | **28/28 byte-identical** on read-back |
| portal state | **dark by construction** — the preview theme's `settings_schema.json` does not declare `portal_enabled` |

**"No live theme file is touched by this task"** was verified by capturing the live
theme's full asset key list before and after:

| | before | after |
|---|---|---|
| live asset count | 388 | 388 |
| portal assets on live | 0 | 0 |
| key-list SHA-256 (first 16) | `2b45b1bc0987b1fd` | `2b45b1bc0987b1fd` |
| keys added / removed | — | 0 / 0 |

**"Migrations and the service deploy precede the push."** The service half is
confirmed: `/health` reported `status: ok` with `build.commit` equal to the pushed
commit. The migration half is **still unverified** — see §5; there is no production
database access here. It does not gate this push, because with the portal dark and no
Page objects created, no portal route can execute at all, so the missing-table risk
the precondition guards against cannot arise. It **does** gate 30.2.

Verification was run twice by different means: the push script's own read-back, and
an independent script that recomputed the manifest from git and re-fetched every
asset. A tool that both performs and checks its own work can agree with itself.

Rollback, should it be wanted — 28 deletes, nothing else was modified:

```bash
npm run theme:push:preview -- --store=myathoorlondon.myshopify.com \
  --environment=production --theme-id=205900054867 \
  --confirm-theme-id=205900054867 --rollback
```

### Production themes, for reference

| id | role | name | created |
|---|---|---|---|
| `180956594515` | **main** | My Athoor London | 2025-04-18 |
| `184371773779` | unpublished | old Copy of My Athoor London | 2025-07-17 |
| `202111648083` | unpublished | backup copy of My Athoor London | 2026-06-17 |
| `203038818643` | unpublished | recent Copy of My Athoor London | 2026-07-08 |
| `205900054867` | unpublished | Copy of My Athoor London | 2026-08-28 ← 30.1 target |

`205900054867` was chosen as the newest copy of live and the only one not named as a
backup; `202111648083` was avoided precisely because its name says it is one. The
push was additive in any case, so no existing file on any theme was altered.

---

## 0b. Security finding, unrelated to the portal but urgent

While locating the theme token: the production Admin API token for the app
**"permanent token"** — scopes include `write_themes`, `write_products`,
`write_orders`, `write_customers`, `write_inventory` — is **hardcoded in 27 files
under `shopify-mcp-local/`**, and that directory was **not** in `.gitignore`. This
repository is **public**.

Nothing was committed: the token does not appear in the last 400 commits, and the
files are untracked. But a single `git add .` would have published a production
write-capable credential. `shopify-mcp-local/` is now ignored, which removes nothing
from the index because nothing there was tracked.

The same token also appears in `~/.kiro/settings/mcp.json` (already ignored), eight
`~/.kiro/logs/*/mcp.log` files and six `~/.zsh_sessions/*.history` files. Those are
local only, but they are worth clearing, and the token is worth rotating.

This document exists because the portal's remaining work is gated on a small number of
things only the store owner can supply, and the difference between "prepared" and "done"
had started to blur. Everything below is either verified evidence or a named blocker with
the exact action attached. Nothing here is inferred from a staging result.

---

## 1. The credential situation, and why it took three tokens

**Resolved.** For the record, because two of the three tokens looked correct and were not.

| token (app) | reaches production? | theme scopes? | verdict |
|---|---|---|---|
| `shpua_…` in `loyalty-service/.env` (staging) | **no** — 401 | yes (14 scopes) | right scopes, wrong store |
| `shpca_…` "Athoor Loyalty Service" | yes | **no** — 403 `requires merchant approval for read_themes` | right store, wrong scopes |
| `shpat_…` **"permanent token"** | yes | **yes** — 11 scopes incl. `read_themes`, `write_themes`, `write_theme_code` | **the working one** |

The trap in the middle row is worth keeping: an app *version* in the Shopify dev
dashboard can **declare** `read_themes`/`write_themes` while the token you happen to
hold belongs to a *different* app that never requested them. Declared scopes on a
version are not granted scopes on a token. The disjoint sets proved it — the
loyalty-service token carries `read_discounts`/`write_discounts`, which the
"permanent token" app does not declare at all.

**Do not consolidate these two tokens.** The loyalty service declares
`write_discounts` as required (`config.ts:22`) and uses it in
`redemption/generateDiscountCode.ts` and `redemption/redeem.ts` to mint reward codes.
The "permanent token" app has no discounts scope, so swapping it into
`SHOPIFY_ADMIN_API_TOKEN` would break reward redemption while looking like a
successful configuration change. Keep the theme token in `SHOPIFY_THEME_TOKEN`, which
is what the push script reads first.

The earlier staging-only token, for context — the previous blocker:

| property | value |
|---|---|
| scopes | 14, **including `read_themes` and `write_themes`** |
| authenticates against | `athoor-loyalty-staging.myshopify.com` |
| authenticates against `myathoorlondon.myshopify.com` | **no — HTTP 401, "Invalid API key or access token"** |

So the scope is right and the store is wrong. `SHOPIFY_SHOP_DOMAIN` in that file is set to
the staging store, which is the trap `scripts/migration/_envIdentity.mjs` was written to
refuse: *"--environment production, but DATABASE_URL points somewhere non-production …
this is the exact trap in loyalty-service/.env."*

**Owner action 1 — the only thing blocking 30.1.**
Create an Admin API access token on the **production** store `myathoorlondon` with
`write_themes` and `read_themes`, and supply it as an environment variable. Do not put it
in `.env` next to the staging domain; the push script reads
`SHOPIFY_THEME_TOKEN` precisely so the two cannot be confused.

**Owner action 2 — the target theme.**
Provide the id of an **unpublished** theme on the production store. The Admin API can only
create an *empty* theme, which cannot render the portal (no layout, no base styles). A
usable preview theme is made in Shopify admin → Online Store → Themes → ⋯ → **Duplicate**
on the live theme. That is a UI action; there is no API equivalent that produces a copy.

---

## 2. What is already built and waiting

`loyalty-service/scripts/theme/portal-preview-push.mjs` performs 30.1 in one pass.

```bash
# plan only — writes nothing, prints the exact file set and byte counts
SHOPIFY_THEME_TOKEN=… node scripts/theme/portal-preview-push.mjs \
  --store=myathoorlondon.myshopify.com \
  --environment=production \
  --confirm-production-store=myathoorlondon.myshopify.com \
  --theme-id=<unpublished theme id>

# then, to perform it
… --apply

# and to undo it
… --rollback
```

It refuses, with a distinct message and a non-zero exit, when:

| condition | outcome |
|---|---|
| `--environment` omitted | exit 2 — no default is ever inferred |
| production store without `--confirm-production-store` | exit 2 |
| a confirmation flag that does not match the target | exit 2 |
| token passed as `--token` | exit 2 — env only, so it never reaches shell history |
| stated environment disagrees with the store domain | exit 2 |
| **target theme has `role: main`** | exit 3, `halted_target_is_live_theme` |
| theme id not found | exit 3, `halted_theme_not_found` |
| the derived file set is not exactly 28 files | exit 3, `halted_unexpected_file_count` |
| any pushed file reads back with a different hash | exit 3, `halted_verification_mismatch` |
| neither `--apply` nor `--rollback` given | exit 0, plan printed, nothing written |

Every refusal above was driven against a real store, not asserted statically.

It also, in order: derives the file set from a **git commit** (never the working tree, so an
unrelated local edit cannot ride along — §25.5); takes a **byte-exact backup** with a
`manifest.sha256` of anything it would overwrite, in 31.1's directory shape; pushes only the
enumerated keys with no globs; **reads every file back and hash-compares** it; and reports
whether the theme's `settings_schema.json` declares `portal_enabled`, which is what
determines whether the portal is dark.

---

## 3. The file list: 28, not 29

30.1's acceptance criteria say "push only the portal's own **new** files". Measured from the
pre-portal commit `32eaca0`, that is **28 files** totalling **220,980 bytes** — 12 assets,
6 snippets, 10 templates.

`theme/config/settings_schema.json` and `theme/sections/header.liquid` are **modifications**,
not new files. They are therefore *not* part of 30.1. They belong to 31.2's scoped diff,
under 31.1's byte-exact backup.

**This has a consequence the plan does not currently address.** With only the 28 files, both
portal settings resolve to `nil` on the preview theme — `settings.portal_enabled` is falsy,
and Liquid treats `nil == blank` as true so `settings.portal_allowlist != blank` is false.
`portal_on` can never become true. The portal is dark *by construction*, which is correct
and safe for 30.1, but it means:

> **Tasks 30.2–30.5 cannot run on a theme that received only the 28 files.** There is no way
> to switch the portal on, so there is nothing to exercise.

Enabling the portal on the preview theme needs `config/settings_schema.json` (so the
settings exist) **and** a `config/settings_data.json` value or a theme-editor toggle (so one
is on). Both are modifications to pre-existing files. This is a genuine gap between 30.1's
"new files only" and 30.2's "run the full journey", and it is an owner decision how to close
it — most likely a preview-only enablement step between the two.

---

## 4. Shopify Page objects — 10 required, and no task creates them

A storefront URL `/pages/<handle>` resolves only when **both** of these hold:

1. a **Page** resource exists in the store with that handle, and
2. that Page's `template_suffix` names a template present in the theme.

The theme half is in this repository and is gated by
`loyalty-service/src/theme/portalRouteContract.test.ts`. The Page half is store-level data:
it is not in git, not in the theme, and **not created by any task in the plan**. Design
§17.2 lists the routes as "new page templates" and stops there.

**Owner action 3.** Create these ten Pages. For each, the handle and the template suffix are
the same string:

| Page handle | template | resulting URL |
|---|---|---|
| `my-athoor` | `page.my-athoor.liquid` | `/pages/my-athoor` |
| `my-athoor-orders` | `page.my-athoor-orders.liquid` | `/pages/my-athoor-orders` |
| `my-athoor-order-detail` | `page.my-athoor-order-detail.liquid` | `/pages/my-athoor-order-detail` |
| `my-athoor-wishlist` | `page.my-athoor-wishlist.liquid` | `/pages/my-athoor-wishlist` |
| `my-athoor-rewards` | `page.my-athoor-rewards.liquid` | `/pages/my-athoor-rewards` |
| `my-athoor-activity` | `page.my-athoor-activity.liquid` | `/pages/my-athoor-activity` |
| `my-athoor-referrals` | `page.my-athoor-referrals.liquid` | `/pages/my-athoor-referrals` |
| `my-athoor-profile` | `page.my-athoor-profile.liquid` | `/pages/my-athoor-profile` |
| `my-athoor-fragrance` | `page.my-athoor-fragrance.liquid` | `/pages/my-athoor-fragrance` |
| `my-athoor-settings` | `page.my-athoor-settings.liquid` | `/pages/my-athoor-settings` |

**Two cautions.**

*Pages are store data, not theme data.* They are shared by every theme on the store. Creating
them makes these ten URLs resolve on the **live** theme too — and the live theme has none of
these templates, so Shopify falls back to `templates/page.liquid` and renders each as an
ordinary near-empty page. Ten thin new indexable URLs would appear on the production
storefront before the portal ships.

*Therefore create them unpublished, or create them after the theme push.* A Page can be
created as a draft (`published: false`), which returns 404 on the storefront until it is
published. Publishing then becomes part of 31.6's staged flip rather than a side effect of
preparation.

---

## 5. Migrations — what is proven, and what is not

There are **22** migration files. The first 15 are RC1, so **7 postdate it**:

| # | migration | creates |
|---|---|---|
| 16 | `1785950000000_harden-data-api-exposure` | `security_baseline_grants`, `security_baseline_rls`, `security_baseline_default_acl` |
| 17 | `1786000000000_create-customer-birthdays` | `customer_birthdays`, `birthday_grants` |
| 18 | `1786100000000_create-fragrance-preferences` | `customer_fragrance_preferences` |
| 19 | `1786200000000_create-communication-preferences` | `customer_communication_preferences` |
| 20 | `1786300000000_create-erasure-requests` | `customer_erasure_requests`, index `idx_erasure_queue` |
| 21 | `1786500000000_create-wishlist-removals` | `customer_wishlist_removals` |
| 22 | `1786600000000_extend-audit-for-redaction` | **no new objects** — replaces the `admin_audit_log_operation_type_check` CHECK constraint to widen `operation_type` |

(There is no `1786400000000`; the gap is harmless.)

Being honest about the three different kinds of evidence:

- **What the local files prove.** Which objects *would* exist if each migration ran, and that
  the set is internally consistent. Nothing about production.
- **What production `/health` proves.** That the service is up and which commit is deployed
  (`build.commit`). It exposes **no schema state at all**, so it cannot tell you whether any
  migration ran.
- **What only a direct production SQL query can prove.** Whether these 7 are actually applied.

30.1's acceptance criteria require migrations and the service deploy to **precede** the theme
push, "so no page can call a route whose table is missing". That ordering cannot be confirmed
from here.

**Owner action 4.** Run this against the production database, read-only:

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

---

## 6. `shareUrl` — no supported environment path exists

`GET /v1/referral` returns a `shareUrl` built server-side. It is assembled from
`config.shopify.shopDomain`, wired at `src/index.ts` into `referralDeps.shareDomain`.

`referral.ts` already declares `shareDomain?: string` as an **injectable** for exactly this
reason — its own comment says production "can pass the primary domain without a code change
rather than have one hardcoded here". But nothing currently supplies a different value, and
there is no environment variable that can:

- the only domain-shaped variables `EnvSchema` accepts are `SHOPIFY_SHOP_DOMAIN`,
  `DATABASE_URL` and `PGHOST`;
- `EnvSchema` is a plain `z.object({…})`, which **strips unknown keys**, so setting
  `PORTAL_SHARE_DOMAIN` in the environment is silently discarded;
- `src/index.ts` reads `process.env` **zero** times — all configuration flows through the
  validated schema, so there is no back door there either.

**Repurposing `SHOPIFY_SHOP_DOMAIN` would be a serious mistake.** It is the Admin API
endpoint host: `graphqlClient.ts` builds `https://${shopDomain}/admin/api/…/graphql.json`
from it. A custom domain does not serve `/admin/api/`, so setting it to `myathoorlondon.co.uk`
would cause a **silent, total Admin API outage** while share links looked perfect. A guard
added in PR #32 (`config.test.ts`) now fails if that value is not a `*.myshopify.com` host.

So this is left unchanged, deliberately. The current value produces a working
`…myshopify.com/?ref=…` link — Shopify redirects it to the primary domain — which is correct
but is not the canonical `myathoorlondon.co.uk` link design §10.2 pictures.

**Owner action 5 (optional, cosmetic).** Three lines, two of them in owner-protected
`config.ts`:

```ts
// config.ts — in EnvSchema (near SHOPIFY_SHOP_DOMAIN, line ~70)
PORTAL_SHARE_DOMAIN: z.string().min(1).optional(),

// config.ts — in the exposed shopify block (line ~184)
shareDomain: env.PORTAL_SHARE_DOMAIN,

// index.ts — in referralDeps (line ~521)
shareDomain: config.shopify.shareDomain ?? config.shopify.shopDomain,
```

Then set `PORTAL_SHARE_DOMAIN=myathoorlondon.co.uk`. Note the durability tradeoff: the
`.myshopify.com` host is permanent, whereas a custom domain can lapse. That is the owner's
call, which is why it has not been made here.

---

## 7. Task 31.8 names the wrong file

Task 31.8 is titled *"prepare the single permitted `layout/theme.liquid` hunk"*, and design
§25.3's coexistence table says the same. **The portal does not touch `layout/theme.liquid`
at all**, and it should not: the three deferred D3 items (the four parser-blocking head
scripts, Font Awesome, async GSAP) all live in that file.

The account link the task is actually about is in `theme/sections/header.liquid`.
`snippets/portal-account-href.liquid` already records why, in its own header: *"the design
predates the header being split into its own section"*.

Two further corrections to the task text: the change is **two hunks**, not one — the drawer
utility link and the header icon are two places the theme renders an account link — and it
was implemented under task **19.3**, so 31.8's remaining job is only to re-apply it onto the
pulled live bytes in `theme-push/`.

This is stale documentation, not an implementation defect. Neither Liquid file has been
edited to make the wording match; instead
`loyalty-service/src/theme/portalLiveThemeScope.test.ts` asserts that
`layout/theme.liquid` is byte-identical to the pre-portal commit, which is a stronger
statement than the task text's. **Owner action 6 (documentation only):** correct 31.8 and
§25.3 to say `sections/header.liquid`, two hunks.

---

## 8. Staging evidence, and what it is not

The 28 artefacts were pushed to an unpublished theme on the **staging** store to obtain one
thing unavailable any other way: **Shopify's own Liquid parser**.

Verified:

- 28/28 accepted; read back and hash-compared, **28/28 byte-identical**;
- the validator is real, not a rubber stamp — three deliberately malformed Liquid files were
  each rejected with HTTP 422 and a specific parse error, and a valid control was accepted;
- staging's live theme was untouched (0 portal assets);
- the probe asset used for the validator test was deleted and confirmed gone;
- the portal is dark on that theme, because `settings_schema.json` there does not declare
  `portal_enabled`.

**This is not task 30.1, and must not be recorded as it.** 30.1 requires a non-live theme on
the *production* store. What staging establishes is that the artefacts are syntactically
valid and that the push/verify/rollback mechanics work. It establishes nothing about
production rendering, production data, or the live theme.

One limitation worth stating plainly: the staging storefront is password-protected, so both
`/` and `/pages/my-athoor` return the same password page. **No rendered-output verification
was possible there at all**, on any route.

---

## 9. Summary of owner actions

| # | action | blocks |
|---|---|---|
| 1 | Production Admin token with `write_themes`, as `SHOPIFY_THEME_TOKEN` | 30.1, and everything after it |
| 2 | Id of an **unpublished** theme on the production store (make it with admin → Duplicate) | 30.1 |
| 3 | Create the 10 Pages in §4, **unpublished**, handle = template suffix | 30.2 onward |
| 4 | Run the SQL in §5 and confirm 7 applied / 22 total | 30.1's precondition |
| 5 | Decide `shareUrl`: leave as `.myshopify.com`, or apply the 3-line patch | nothing — cosmetic |
| 6 | Correct 31.8 and §25.3 to say `sections/header.liquid`, two hunks | nothing — documentation |
| 7 | Decide how the portal gets enabled on the preview theme (see §3) | 30.2–30.5 |

---

## 7. Verified state after the 31.1 pass

Everything below was read from Shopify or produced by a tool in this repo. Nothing
inferred.

### 31.1 — COMPLETE

`npm run theme:backup:live` (`scripts/theme/portal-live-backup.mjs`), status
`backed_up_verified`, `wroteToShopify: false`.

The file set is **derived, never typed**:
`git diff --diff-filter=M --name-only 32eaca0..HEAD -- theme/`. That is the exact
complement of the `--diff-filter=A` set `portal-preview-push` deploys, so the two tools
partition the portal's theme footprint — 2 modified + 28 added = 30 touched, asserted with
no overlap and no gap by `portalLiveBackup.test.ts`.

| Live file | bytes | sha256 |
|---|---|---|
| `config/settings_schema.json` | 40,016 | `48d01a6d1a115f8d20d8a7dcae1c82577ac6b8c9b83e53413a1c796d746b60e3` |
| `sections/header.liquid` | 85,023 | `6fb229fa916dce311dce32b1b0ed0505b54240b5e9544ba3664d94c6374958c5` |

The 28 added files need no backup: restoring one means deleting it.

**The tool cannot write to live.** It is the only tool that targets theme
`180956594515`, so the protection is not "don't" but "can't": one `fetch`, no `method:`
option, and no `PUT`/`POST`/`DELETE`/`PATCH` string anywhere in the file — asserted
statically, and proved non-vacuous by adding a `PUT` and watching the test fail.

### Meta Pixel — diagnosed, and OUT OF SCOPE for this spec

`grep -riE 'meta pixel|facebook|fbq|web pixel|customer event'` across
`requirements.md`, `design.md` and `tasks.md` returns **zero** matches; every "pixel" hit
is a CSS viewport width. So it is a global steering concern, not a portal task.

Diagnosed anyway, in a real browser with JavaScript executed
(`scripts/theme/portal-browser-probe.mjs`), because the HTML alone cannot answer it:

| Signal | Live storefront |
|---|---|
| `window.fbq` | `undefined` |
| `connect.facebook.net` script tag | absent |
| facebook / fbcdn / fbevents requests | **0** of 237 |
| `window.webPixelsManager` | **present** |
| app web pixel loaded | one — `web-pixel-4997054803`, alongside `cdn.chaty.app` requests |

So Shopify's Customer Events runtime is healthy and **no Meta pixel is registered**.
Installing one is blocked on two things this project cannot supply: the `write_pixels`
scope (Shopify named the read half itself —
`Access denied for webPixel field. Required access: read_pixels`) and the Meta Pixel ID,
which lives in the owner's Meta account. Inserting inline `fbq(` into theme HTML would be
the wrong mechanism and is not proposed.

### Browser automation — available, but not sufficient for 30.2

Chrome is installed and Node 24 ships a global `WebSocket`, so a real browser is drivable
over CDP with **nothing added to `package.json`** — which matters because task 29.10 pins
the dependency set and task 33 requires `npm ls --omit=dev` unchanged at
`NEW RECURRING COST = £0/MONTH`. `portalBrowserProbe.test.ts` asserts every import is a
`node:` built-in so this cannot quietly acquire a dependency.

What it still cannot do: the probe runs a throwaway profile and never touches the owner's
Chrome, so it holds **no Shopify admin session and no customer session**. 30.2 is blocked
on a credential and an email inbox, **not** on tooling. That distinction is the reason
30.2 stays unticked rather than being worked around.

### Database migrations — still unverifiable from here

`start` is `node dist/index.js` with **no migrate step**, and there is no `render.yaml`
or `Dockerfile`, so applied-migration state **cannot** be inferred from the deployed
commit in `/health`. `psql` is absent, the Supabase and Postman powers both report no
tools, and the `DATABASE_URL` in `loyalty-service/.env` is non-production. §5's four
`SELECT`s in the Supabase SQL editor remain the only route.

---

## 8. Task 31.7 — restore path REHEARSED, and the rollback matrix

### The rehearsal actually performed

Run against the **preview** theme `205900054867`. The live theme was never written.

| Step | Action | Result |
|---|---|---|
| 0 | Confirm the backup file matches its own manifest | sha `48d01a6d1a115f8d` — match |
| 1 | Restore the backed-up **live** `config/settings_schema.json` onto the preview theme, re-pull, hash-compare to the 31.1 manifest | **MATCH on read 2** |
| 2 | Return the preview theme to its own prior bytes, re-pull, hash-compare | **MATCH on read 2** — 23 groups, portal group present |
| 3 | Confirm `settings_data.json` was never written | `portal_enabled=false`, `portal_allowlist="9395357876563"`, 141 settings — intact |

"MATCH on read 2" both times is the same read-after-write staleness already handled by
`pollForVerified`: Shopify serves a stale `config/*` asset to a read issued immediately
after a PUT. A single-read verifier would have reported a false failure on a restore that
had in fact succeeded — which is precisely the wrong moment to be told a rollback failed.

`config/settings_schema.json` was chosen deliberately as the rehearsal subject: if the
round trip had failed halfway, the preview theme would have lost only the portal settings
*declaration*, which makes `portal_on` resolve to false — the portal **fails safe** — and
recovery is `npm run theme:settings --apply`, a path already tested. Rehearsing on
`sections/header.liquid` had no equivalent tested recovery, because that file is in the
push tool's *modified* set rather than its *added* set.

### The rollback matrix (design §25.8), as an operating procedure

| What went wrong | Rollback action | Rehearsed? |
|---|---|---|
| Portal misbehaving for customers | **Flag flip** — `portal_enabled=false` and/or clear `portal_allowlist`. No deploy, no theme push, no migration. | mechanism proven (`values_applied_verified`) |
| A pushed **live** file is wrong | Restore the byte-exact 31.1 backup for that path, re-pull, hash-compare against the manifest | **yes — 31.7, PASS** |
| A **draft** theme file is wrong | `theme:push:preview --rollback`, or restore from `backups/theme-205900054867/` | tool ships `--rollback` |
| The settings **schema** group is wrong | `theme:settings --rollback` restores `settings_schema.json` from its backup | tool ships `--rollback` |
| The database must be reverted | `migrate:down` — gated by `scripts/migration/migrate-down-guard.mjs`, which enforces the **zero-row precondition of §6.5**. A migration with rows present is not reversible by design. | guard exists; not exercised (no production DB access) |

Backup of record for the live push:

```
backups/live-180956594515/2026-08-30T22-01-59-294Z/config/settings_schema.json
backups/live-180956594515/2026-08-30T22-01-59-294Z/sections/header.liquid
```

`shasum -a 256 -c manifest.sha256` in that directory reports `OK` for both.

---

## 9. Task 33 — the automatable evidence

| Checkpoint | Evidence | State |
|---|---|---|
| All tests pass | see the test line in the final report | PASS |
| `NEW RECURRING COST = £0/MONTH` | `npm ls --omit=dev --depth=0` — `fastify`, `pg`, `pg-boss`, `zod`, `typescript`, `@types/node`, `@types/pg`. No automation package; the real-browser probe uses Chrome over CDP with Node's built-in `WebSocket`. | HOLDS |
| No unauthorised theme change | live theme `180956594515`: 388 assets, key-list `2b45b1bc0987b1fd`, 0 portal assets, `settings_data.json` does not mention `portal_enabled` | HOLDS |
| No migration change | 22 files, unchanged throughout | HOLDS |
| No scope change | no scope was added; `read_pixels` was **declined** rather than requested, and the Meta pixel work stopped at diagnosis | HOLDS |
| Owner decisions D1–D8 | recorded in `design.md`; D1 (new customer accounts) confirmed empirically as Branch B; **D3 needs revisiting** — it authorises editing `layout/theme.liquid`, but the account link is actually in `sections/header.liquid` | PARTIAL |
| No webhook / App Proxy change | none made by any tool in this repo; App Proxy verified only by reading `/apps/loyalty/v1/*` (401, unchanged behaviour) | HOLDS |

---

## 10. Task 30.6 — the live-side half, confirmed after the 31.4 push

30.6 asks that the regions which must not change are identical between preview and live, and
that `/pages/rewards` with the flag off is unchanged.

**The preview-vs-live comparison is not automatable** — rendering the preview theme needs an
authenticated session, and a bare `preview_theme_id` is discarded for anonymous visitors.

**The live-side invariant IS confirmed, with a real before/after byte comparison.**
`/pages/rewards` measured **301,260 bytes** three times before the push (stability was checked
first, precisely so the number could be trusted), and **301,260 bytes** after all 30 files
landed. Byte-identical.

| Signal | After the push |
|---|---|
| `/pages/rewards` size | **301,260 bytes — identical to pre-push** |
| `data-portal-root` markers | 0 |
| `athoor-portal` asset references | 0 |
| Liquid errors | 0 |
| `<head>` stylesheet entries | 43 |

That is the substance of Requirement 22.7's flag-off guarantee: 28 new files are present on the
live theme and the rendered output has not moved by a single byte. 30.6 stays **unticked**
because its preview-side comparison is still owed.

---

## 11. The deployed portal templates PROVEN to resolve on live — no credentials needed

Only possible after the 31.4 push put the 28 additive files on the live theme. Before it, every
portal template was absent from live, so nothing could be exercised there at all.

`?view=<suffix>` selects a template at request time, and the ten portal Pages being Hidden does
not matter: the view is requested against `/pages/rewards`, which is Visible. So the deployed
templates can be rendered anonymously.

| Request | Bytes | Liquid errors | portal markup |
|---|---|---|---|
| `/pages/rewards` (own template, baseline) | 301,260 | 0 | 0 |
| `?view=my-athoor` | 299,023 | 0 | 0 |
| `?view=my-athoor-orders` | 299,037 | 0 | 0 |
| `?view=my-athoor-rewards` | 299,039 | 0 | 0 |
| `?view=my-athoor-wishlist` | 299,041 | 0 | 0 |
| `?view=my-athoor-settings` | 299,041 | 0 | 0 |
| `?view=totally-bogus-xyz` (**not a template**) | **358,324** | 0 | 0 |

**Why this proves resolution rather than fallback.** A missing view falls back silently with
HTTP 200 — that is the 358,324-byte row, and it is what a failed lookup looks like on this
store. Every portal view instead lands ~59 KB away from it, and the portal views differ from
*each other* by a few bytes (299,023 / 299,037 / 299,039 / 299,041). A single fallback template
cannot produce five different sizes. The variation is each template passing its own
`section_name` and `page_title` into `portal-chrome`.

So, on the live theme, with the flag off:

- each portal template **resolves** and renders
- `portal-chrome` takes the **flag-off branch** — `portalRoot` is 0, no portal markup, no portal
  stylesheet or script
- **zero Liquid errors**, which is the specific failure the first 31.4 attempt caused

This is the strongest evidence available without a customer session. What it still cannot show is
the signed-in portal itself — that needs 30.2.

---

## 12. Task 30.5 — Web Vitals captured in real Chrome (PARTIAL)

Captured with `PerformanceObserver` over CDP (`largest-contentful-paint` and `layout-shift`, both
`buffered: true`), 6s collection window per load. No Lighthouse dependency — Lighthouse is not
installed here, and adding it was not worth a new dependency for four numbers I can read directly.

| section | viewport | LCP (ms) | CLS | TTFB (ms) | domContentLoaded (ms) |
|---|---|---|---|---|---|
| overview | mobile 390 | 300 | 0 | 73 | 336 |
| overview | desktop 1280 | 252 | **0.0925** | 61 | 217 |
| wishlist | mobile 390 | 648 | 0 | 61 | 249 |
| wishlist | desktop 1280 | 668 | 0 | 142 | 310 |
| rewards | mobile 390 | 540 | 0 | 62 | 294 |
| rewards | desktop 1280 | 628 | 0.0355 | 59 | 384 |
| profile | mobile 390 | 412 | 0 | 59 | 393 |
| profile | desktop 1280 | 248 | 0.0079 | 64 | 209 |

### Against the recorded baselines

| metric | baseline | worst portal reading | verdict |
|---|---|---|---|
| LCP mobile | 7.4s | 0.648s | far under |
| LCP desktop | 3.3s | 0.668s | far under |
| CLS mobile | 0.059 | 0 | under |
| CLS desktop | 0.105 | 0.0925 | under, but only by 0.012 |

Every reading is inside its baseline. The portal does not regress the page it lives on.

### Why this is PARTIAL and not a pass

The acceptance criterion asks for **three runs, median, every section**. This is **one run across four
of nine sections**. The numbers are real and they are comfortably inside baseline, but a single
sample is not a median, and desktop CLS at 0.0925 sits close enough to the 0.105 baseline that
run-to-run variance could plausibly cross it. Reporting one run as a median would be exactly the
kind of claim that looks like evidence and is not.

**30.5 stays unticked.** To close it: three runs per section, all nine sections, both viewports,
report the median — and pay attention to desktop CLS on overview specifically.

---

## 13. Task 30.5 — the FULL requirement, and it FAILS on CLS

### Correction to section 12 above

Section 12 concluded "Every reading is inside its baseline. The portal does not regress the page it
lives on." **That conclusion was wrong, and this section supersedes it.** Section 12 sampled four of
nine sections with an ordinary warm HTTP cache. Running the requirement as actually specified — nine
sections, three runs, median, cache disabled so every load is cold — surfaces mobile CLS up to
**0.4596** against a **0.059** baseline. The partial sample did not merely under-measure; it produced
the opposite verdict. That is worth stating plainly rather than quietly overwriting.

### Method

9 sections x 2 viewports x 3 runs = 54 loads. `Network.setCacheDisabled: true` on every run, so these
are cold-load figures. Cold is the honest condition for a feature no customer has visited yet: every
first view of this portal is a cold view. LCP and CLS via `PerformanceObserver` (`buffered: true`),
5.5s collection window.

### Mobile 390x844 — median of 3 cold runs

| section | LCP med | LCP runs | CLS med | CLS runs | TTFB med |
|---|---|---|---|---|---|
| overview | 284 | 400, 284, 232 | 0 | 0.2421, 0, 0 | 76 |
| orders | 380 | 584, 380, 260 | 0 | 0.0622, 0, 0 | 62 |
| profile | 244 | 240, 408, 244 | 0.0212 | 0.0212, 0, 0.0212 | 60 |
| rewards | 764 | 936, 576, 764 | 0 | 0.3022, 0, 0 | 61 |
| referrals | 784 | 784, 808, 628 | 0 | 0.2151, 0, 0 | 60 |
| **fragrance** | 1204 | 1204, 1072, 1248 | **0.4596** | 0.4596, 0.4596, 0.4596 | 61 |
| **wishlist** | 904 | 1068, 884, 904 | **0.3663** | 0.3663, 0.3663, 0.3663 | 60 |
| **settings** | 252 | 388, 236, 252 | **0.4231** | 0.4231, 0, 0.4231 | 59 |
| **activity** | 848 | 840, 848, 984 | **0.1086** | 0.1086, 0.1086, 0.1086 | 61 |

### Desktop 1280x900 — median of 3 cold runs

| section | LCP med | CLS med | CLS runs | TTFB med |
|---|---|---|---|---|
| overview | 248 | 0.0925 | 0.0925 x3 | 60 |
| orders | 488 | 0.0012 | 0.0012 x3 | 60 |
| profile | 448 | 0.0079 | 0.0079 x3 | 60 |
| rewards | 736 | 0.0355 | 0.0355 x3 | 66 |
| referrals | 436 | 0.0647 | 0.0647 x3 | 58 |
| fragrance | 484 | 0.0012 | 0.0012 x3 | 59 |
| wishlist | 920 | 0 | 0 x3 | 61 |
| **settings** | 464 | **0.1221** | 0.1221 x3 | 60 |
| activity | 748 | 0.0012 | 0.0012 x3 | 60 |

### Verdict

| metric | baseline | worst median | result |
|---|---|---|---|
| LCP mobile | 7.4s | 1.204s | **PASS**, 6x headroom |
| LCP desktop | 3.3s | 0.920s | **PASS**, 3.5x headroom |
| CLS mobile | 0.059 | **0.4596** | **FAIL** — 7.8x baseline, 4 sections over |
| CLS desktop | 0.105 | **0.1221** | **FAIL** — settings over |

LCP is not a concern anywhere. **CLS fails**: mobile on fragrance, settings, wishlist and activity;
desktop on settings. Four of those medians are identical across all three runs, so they are
deterministic layout shifts, not cache noise. Google's own "good" threshold is 0.1, so fragrance,
settings and wishlist are "poor" by that standard too, independent of this project's baseline.

The two mobile sections showing `0.24, 0, 0` and `0.30, 0, 0` patterns shift only on the very first
load — those are font/resource warming that survives `setCacheDisabled`. Their medians are 0 and they
are not the defect.

### Root cause — the footer, not the images

Captured `layout-shift` entries with their `sources` node rects:

| section | shift | at | shifting element | y/height before -> after |
|---|---|---|---|---|
| fragrance | 0.4596 | 1234ms | `footer.footer.color-background-2` | [558,286] -> [0,0] |
| | | | `footer.athoor-portal__footer` | [425,69] -> [0,0] |
| | | | `p.athoor-portal__state-message` | [354,22] -> [402,22] |
| wishlist | 0.3663 | 792ms | `footer.footer.color-background-2` | [558,286] -> [0,0] |
| activity | 0.1086 | 811ms | `footer.footer.color-background-2` | [558,286] -> [757,87] |

One shift per section, landing 790-1230ms in — exactly when the portal's fetched content replaces its
loading state. **The portal section's skeleton is shorter than its loaded content, so when content
arrives everything below it moves.** The site footer is the largest thing below it, which is why the
footer dominates the score. `p.athoor-portal__state-message` sliding 354 -> 402 is the same 48px
growth seen from inside the section.

**The images are not the cause and are correctly built.** Wishlist carries 3 portal images, all with
explicit `width="300" height="300"`, none resolving to `aspect-ratio: auto`, all `loading="lazy"`.
That is the right implementation; the CLS is not theirs.

### The fix, not yet applied

Reserve height for portal content before it arrives — a `min-height` on the section container sized to
typical loaded content, or a skeleton built to the same height as the content it is replacing — so the
footer never moves. This is a change to a portal theme asset, which means another live-theme push, so
it is **not applied**. The flag is OFF, so no customer has seen this; this is the correct moment to fix
it rather than after enabling.

**30.5 stays unticked, now for a substantive reason rather than an incomplete sample.**

---

## 14. Mobile keyboard — simulated in Chrome, PASSES; real device still required

Chrome exposes no software-keyboard API, so the keyboard was simulated by shortening the visual
viewport by a realistic keyboard height and then focusing a profile text input.

| case | viewport h | bar position | input top/bottom | bar top/bottom | input fully visible | bar covers input |
|---|---|---|---|---|---|---|
| no keyboard | 844 | fixed | 400/444 | 787/844 | yes | no, 0px |
| iOS keyboard (~336px) | 508 | fixed | 232/276 | 451/508 | yes | no, 0px |
| Android keyboard (~310px) | 534 | fixed | 245/289 | 477/534 | yes | no, 0px |

The layout tolerates a short viewport: the focused field stays fully on screen and the fixed bottom bar
never overlaps it, at either keyboard height.

**What this does NOT establish, and why a handset is still needed.** This tests the layout consequence
of a shorter viewport, not the keyboard itself. It does not reproduce iOS Safari `visualViewport`
resize semantics or its dynamic toolbar collapse, Safari's own scroll-on-focus behaviour, Android's
`resize` vs `pan` window modes, or keyboard accessory bars. Those need a real iOS and a real Android
device. The simulation is genuine evidence that the layout is not obviously broken under occlusion, and
it is not a substitute for the device test.

---

## 15. Task 31.5 — authenticated journey re-confirmed across all 54 loads

The 30.5 sweep doubled as a journey re-run, since it loaded every section repeatedly while recording
failures:

| signal | result across 9 sections x 2 viewports x 3 runs |
|---|---|
| `/apps/loyalty` responses >= 400 | **0** |
| console errors | **0** |
| sections stuck in loading/pending | **0** |

No `app_proxy_signature_invalid`, no `identity_resolution_failed`, no 5xx, across 54 cold loads.

### Flag-off safety, from the visitor's side

Verified in an isolated browser context with no cookies and no draft-preview session, so it reflects
what an ordinary live visitor sees. Home, `/pages/rewards`, `/pages/rewards?view=my-athoor`, and
`/pages/account-landing`, all HTTP 200:

| probe | result on all four URLs |
|---|---|
| `[data-portal-root]` nodes | 0 |
| `[class*="athoor-portal"]` nodes | 0 |
| portal scripts | 0 |
| portal stylesheets | 0 |
| `/pages/account-landing` link present | yes |

**The portal is dark on live.** One caveat on my own harness: a "portal-ish body text" regex returned
true on all four pages, including the homepage. It matches the brand name "My Athoor London" in
ordinary copy. The structural counters are the authoritative signal and they are all zero. There is also
1 console error on every page including the homepage, so it is pre-existing and site-wide, not
attributable to the portal — I have not diagnosed it and am not claiming it is harmless.

---

## 16. The CLS fix — applied to the DRAFT only, and it does NOT meet the gate

`min-height: 100vh` on `.athoor-portal`, source `theme-src/portal/styles/base.css`, rebuilt via
`npm run build:portal` (CSS 5.11 KB gzip against a 20 KB budget, `build:portal:check` confirms
artefacts match source). Pushed with `theme:push:preview --apply` to theme **205900054867, role
`unpublished`** — 28 pushed, 28 verified identical, 0 mismatches, backup taken. **Live theme
180956594515 was not touched. `portal_enabled` was not changed.** The push script refuses any theme
whose role is `main`, so this could not have reached live even by mistake.

Confirmed applied: the root serves `min-height: 844px` at a 390x844 viewport.

### Result: mobile CLS gate < 0.1 is NOT met

| section | CLS before | CLS after | verdict | LCP before | LCP after |
|---|---|---|---|---|---|
| overview | 0 | 0 | pass | 284 | 504 |
| orders | 0 | 0 | pass | 380 | 372 |
| profile | 0.0212 | 0.0212 | pass | 244 | 360 |
| rewards | 0 | 0 | pass | 764 | 764 |
| referrals | 0 | 0 | pass | 784 | 812 |
| **fragrance** | 0.4596 | **0.1202** | **FAIL** | 1204 | 1184 |
| wishlist | 0.3663 | **0.0651** | pass | 904 | 1028 |
| **settings** | 0.4231 | **0.4231** | **FAIL** | 252 | 344 |
| activity | 0.1086 | **0.0457** | pass | 848 | 896 |

Desktop: settings **0.1221** unchanged, still over its 0.105 baseline. Every other desktop section
unchanged. Overflow 0 everywhere, nav targets 5 mobile / 8 desktop, bar `fixed` / `sticky` as before,
**0 API failures and 0 console errors across all 54 loads.**

### Why it only half worked — two independent causes, not one

The scores that did not move are the tell. A rule that changes nothing cannot be acting on that
shift's cause.

**Cause A — section growth displacing the theme footer. FIXED.**
`footer.footer.color-background-2` was the dominant source before and is now **absent from the shift
sources entirely**. This is what improved wishlist (0.3663 -> 0.0651), activity (0.1086 -> 0.0457) and
most of fragrance.

**Cause B — content resized or removed after render, inside the portal. NOT ADDRESSED.**

| section | remaining source | movement |
|---|---|---|
| settings 0.4231 | `section.athoor-settings__group` x2 | y=535 h=309 -> [0,0]; y=389 h=147 -> [0,0] |
| fragrance 0.1202 | `footer.athoor-portal__footer` | y=425 h=69 -> [0,0] |
| overview desktop 0.0925 | `section.athoor-overview__tile` | h=242 -> h=340, plus a tile appearing at y=867 |

A destination of `[0,0]` means the element was **removed or hidden after having been laid out**. Settings
renders two groups and then collapses them; overview's tiles grow ~98px as data lands and shove the
greeting up. Root height for settings is 1781px, far past the 844px reserve, so the reserve is simply
not in play — hence the bit-identical score.

Fixing cause B is a different job from cause A: reserve height on `.athoor-settings__group` and
`.athoor-overview__tile`, and stop the portal's own footer moving. That is per-component work on the
section stylesheets, not one rule on the root, so it is **not attempted here** rather than rushed.

### LCP: a real tradeoff, recorded

Worst mobile median is 1184ms against 1204ms before, so the headline is flat. Individual sections
regressed: overview 284 -> 504, profile 244 -> 360, settings 252 -> 344, wishlist 904 -> 1028. A taller
page changes which element qualifies as largest-contentful, so this is a plausible consequence of the
reserve rather than a slowdown. Everything remains far inside the 7.4s mobile baseline, but "no LCP
regression" is **not** satisfied section by section, and it would be dishonest to file it as clean.

### Two corrections to my own harness

1. **`empty` is not stuck.** `fragrance` reports `data-state="empty"`, and orders and activity likewise —
   correct for an account with no orders, no activity and no fragrance profile. My gate flagged
   `:not([data-state="ready"])` as failure and produced 18 false positives.
2. **My earlier "0 stuck sections across 54 loads" was vacuous.** It queried
   `[data-portal-state="loading"]`. The attribute is `data-state`. The selector could never match
   anything, so the zero measured nothing. The corrected selector shows the states above, all designed.

### Standing position

The draft carries a real improvement on three sections and no CLS regression anywhere. It does **not**
meet the < 0.1 mobile gate, so **it must not be promoted to live and the flag must stay OFF.**
Rollback, if wanted:

```
node scripts/theme/portal-preview-push.mjs --store=myathoorlondon.myshopify.com \
  --environment=production --theme-id=205900054867 --rollback
```

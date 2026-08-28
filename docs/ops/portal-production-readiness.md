# Portal production readiness — what is prepared, what is blocked, what the owner must do

Status at time of writing: **tasks 1–29 complete. Task 30.1 blocked on one credential.**

This document exists because the portal's remaining work is gated on a small number of
things only the store owner can supply, and the difference between "prepared" and "done"
had started to blur. Everything below is either verified evidence or a named blocker with
the exact action attached. Nothing here is inferred from a staging result.

---

## 1. The blocker, precisely

Task 30.1 pushes the portal to a **non-live theme on the production store**, so that
30.6 can diff the preview theme's rendered output against the live theme's. Both themes
must be on the same store with the same data, or the diff compares two different shops.

The Admin token currently present in `loyalty-service/.env`:

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

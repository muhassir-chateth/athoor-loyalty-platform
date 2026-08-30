# Return policy: 14 days -> 30 days — inventory, changes, and what was deliberately left

Inspection first, then change. Every occurrence below was read in context and classified
before anything was edited.

## 1. Complete inventory — 16 repository occurrences, classified

Search: `(14\s*-?\s*days?|fourteen\s+days?)` case-insensitive across `*.liquid`, `*.json`,
`*.ts`, `*.js`, `*.md`, `*.mjs`, excluding `node_modules`.

### CHANGED — customer-facing current return policy (9 replacements, 5 files)

| File | Before | After |
|---|---|---|
| `theme/sections/athoor-tasting-notes.liquid` | `14-day easy returns` | `30-day easy returns` |
| `theme/config/settings_data.json` | `• 14-DAY EASY RETURNS` | `• 30-DAY EASY RETURNS` |
| `theme/templates/index.json` (x2) | `WITHIN 14 DAYS FREE RETURNS` | `WITHIN 30 DAYS FREE RETURNS` |
| `theme/templates/product.json` | `within 14  days of delivery` | `within 30 days of delivery` |
| `theme/templates/product.json` | `Free returns within 14 days` | `Free returns within 30 days` |
| `theme/templates/product.json` | `14-day easy returns` | `30-day easy returns` |
| `theme/templates/product.product-identity.json` | `within 14  days of delivery` | `within 30 days of delivery` |
| `theme/templates/product.product-identity.json` | `Free returns within 14 days` | `Free returns within 30 days` |

The `within 14  days` source had a double space; the replacement normalises it to one.

### LEFT UNCHANGED — unrelated

| Location | What it actually is |
|---|---|
| `docs/ops/backup-and-recovery.md:18` | GitHub **artifact retention** — 14 days of CI build artifacts |
| `docs/ops/backup-and-recovery.md:271` | the same retention restated against a ≥7-day requirement |
| `loyalty-service/src/profile/birthday.test.ts:137,148` | the **birthday grant window**, a loyalty mechanic with no connection to returns |

### LEFT UNCHANGED — historical

| Location | Why |
|---|---|
| `backups/theme-205900054867-settings/2026-08-30T21-02-54-517Z/settings_data.json:521` | a byte-exact rollback snapshot. Editing it would corrupt the restore point and break its sha256 manifest. |
| `backups/theme-205900054867-settings/2026-08-30T21-06-04-664Z/settings_data.json:521` | same |

### LEFT UNCHANGED — customer-facing, but NOT the return policy (see §4)

| Location | Text |
|---|---|
| `theme/snippets/cart-drawer.liquid:713` | `Points from this order will be credited to your account after 14 days.` |

This is the **loyalty points crediting hold**, not the return window. It is not a
find-and-replace target — but it is now materially coupled to this change. See §4.

### Already correct — no change needed

`theme/templates/product.dublicate-product.json` already read `within 30 days of delivery`
and `within four weeks` for refund processing, so the repository was already inconsistent
with itself before this sweep. Nothing to change; recorded because it explains why the
target wording was chosen to match.

### Checked and clear

- **Locale files** (`theme/locales/*.json`, 50+ files): every `return`/`refund` key is a UI
  label ("Return to cart" and similar). **Zero** contain a day count. Note they open with a
  `/* */` comment block, so they are not strict JSON and a naive parse fails.
- **`theme/templates/page.faq.json`**: has the question "What is your return policy?" but
  the answer is **lorem ipsum placeholder text** with no period stated. Nothing to change
  here — but it is a real content defect worth fixing separately.
- **Shopify Pages** (27 scanned via Admin API): **zero** contain a return/refund reference
  with a day count.

## 2. Shopify shop policy — BLOCKED, and one sentence must not be touched

`Settings -> Policies -> Refund policy` (2,833 chars) currently contains three `14`s. They
are not equivalent:

| Sentence | Verdict |
|---|---|
| `We have a 14-day return policy, which means you have 30 days after receiving your item to request a return.` | **the store's own policy, and self-contradictory today.** Must become `30-day`. |
| `European Union 14 day cooling off period` | **EU statutory (Consumer Rights Directive).** 14 days by law. **MUST NOT CHANGE.** |
| `you have the right to cancel or return your order within 14 days, for any reason and without a justification` | same statutory right. **MUST NOT CHANGE.** |

Changing the EU figure to 30 would be a false statement of law, which is exactly why the
instruction to not blindly replace every `14` matters here.

**The edit is prepared but could not be applied.** Shopify refused, naming the scope itself:

```
Access denied for shopPolicyUpdate field.
Required access: `write_legal_policies` access scope.
```

No change was attempted beyond that refusal. Backup and the exact proposed body are at:

```
backups/shop-policies/2026-08-30T22-18-00Z/policies.json               all 4 policies, as read
backups/shop-policies/2026-08-30T22-18-00Z/refund-policy.before.html   sha256 bb5717b58fb515b6
backups/shop-policies/2026-08-30T22-18-00Z/refund-policy.proposed.html one sentence changed, EU text intact
```

## 3. This is a SEPARATE live-theme change set from the portal

The sweep modified five live theme files that the portal does not touch. That takes the
project's modified-live-file count from **2 to 7**, and 31.2 forbids a push carrying
unrelated hunks. So:

- `theme-push/` stays **portal-only** — `config/settings_schema.json` and
  `sections/header.liquid`. Two assertions in `portalProductionDiff.test.ts` now fail if it
  ever widens to carry the policy files, because re-deriving the staged set from
  `git diff --diff-filter=M` would now silently bundle them.
- The policy change needs **its own** backup, diff and approval before any live push. Task
  31.1's tool derives its file set, so re-running it now captures all seven.

## 4. The link to the future points/refund requirement

Recorded, deliberately **not** implemented — see
`docs/future/refund-points-clawback-requirement.md`.

Widening the return window from 14 to 30 days makes that gap concrete rather than
theoretical. `cart-drawer.liquid` tells customers their points are credited **after 14
days**. That hold almost certainly existed *because* the return window was 14 days: points
landed only once the purchase could no longer be returned.

With returns now running to 30 days, points credit at day 14 while a return remains
possible for another 16 days — so a customer can be credited, redeem, and then return the
purchase. That is precisely the exposure the clawback requirement describes, and this
policy change opens a 16-day window for it.

**Not changed here**, because the crediting hold is points accounting, not policy text, and
changing it silently would alter loyalty behaviour under cover of a copy edit. It needs a
decision: extend the hold to 30 days, or keep 14 and rely on clawback. That belongs to the
follow-up task.

## 5. Record corrections (kept visible on purpose)

Two of my own errors during this sweep, corrected forward rather than rewritten:

1. **A false non-vacuity claim.** Commit `c38cebb` stated the split blast-radius guard was
   "proved by modifying an undeclared file and watching the guard fire". It was not — that
   attempt produced GREEN. `modifiedThemeFiles()` derives from
   `git diff --diff-filter=M <pre-portal-commit> HEAD -- theme/`, so it compares **commits**
   and an uncommitted edit is invisible to it. Non-vacuity was re-proved through the
   declaration, which is what a HEAD-based guard can police: dropping a declared file fails
   1 assertion, moving a policy file into the portal's list fails 3. The limitation is now
   recorded in the test itself. It is the same false-green the D3 assertion in that file
   already avoids by reading from disk while taking its baseline from a commit.

2. **A stray `git stash`.** A line I wrote as a "no-op guard" inside a verification script
   was not a no-op: it stashed the uncommitted guard fix, which is why the old assertion name
   reappeared and a commit found nothing to commit. Recovered in full with `git stash pop`
   (the stash held exactly one file). Nothing was lost, but the script had no business
   running a git command at all.

Commit `9145c80` also carries one mangled sentence: its message used backticks inside a
double-quoted shell string, so zsh ran the quoted git command as a substitution and dropped
it. The command it should have named is the one in item 1 above.

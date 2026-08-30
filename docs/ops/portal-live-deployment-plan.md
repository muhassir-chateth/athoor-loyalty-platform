# Portal live deployment — the COMPLETE dependency closure and guarded plan

Recomputed after the 31.4 incident, in which an incomplete set broke the live storefront.
**Nothing has been pushed. The flag is off. This awaits your approval.**

## Why the previous set was wrong

The approved two-file set was `config/settings_schema.json` and `sections/header.liquid`.
`header.liquid` renders `portal-account-href`, which was not on live, so Shopify rendered the
error into the account link on every page. Rolled back; live verified byte-identical to
baseline.

Recomputing exposed a second, deeper instance of the same class. Ten per-section bundles are
**not statically reachable**, because `portal-chrome.liquid` line 113 builds the filename at
render time:

```liquid
<script src="{{ 'athoor-portal-' | append: section_name | append: '.js' | asset_url }}" defer></script>
```

A closure built only from literal asset references finds `athoor-portal-core.js` and
`athoor-portal.css` and misses all ten. Pushing that subset would have rendered the portal with
every section silently failing to load — visible only as sections stuck loading forever, which
is the PR #28 defect signature and would have looked like a portal bug rather than a bad push.

## The complete set — 30 files

Derived, never typed: 28 additive files from
`git diff --diff-filter=A ... -- theme/`, plus the 2 files the portal modifies.

| Directory | Files | Staging |
|---|---|---|
| `assets/` | 12 | new — copied verbatim |
| `config/` | 1 | modified — staged from live bytes |
| `sections/` | 1 | modified — staged from live bytes |
| `snippets/` | 6 | new — copied verbatim |
| `templates/` | 10 | new — copied verbatim |

- **12 assets** — `athoor-portal.css`, `athoor-portal-core.js`, and the **10 per-section
  bundles** (overview, orders, order-detail, wishlist, rewards, activity, referrals, profile,
  fragrance, settings)
- **6 snippets** — `portal-chrome`, `portal-nav`, `portal-section`, `portal-more-sheet`,
  `portal-signin-invitation`, `portal-account-href`
- **10 templates** — `page.my-athoor*.liquid`
- **1 config** — `config/settings_schema.json` (modified: 22 live groups preserved, one appended)
- **1 section** — `sections/header.liquid` (modified: the two flag-gated account-link hunks only)

## Deliberately excluded

| Excluded | Why |
|---|---|
| the 7 `aria-label` hunks in `header.liquid` | your instruction — separate release |
| `config/settings_data.json`, `templates/index.json`, `templates/product.json`, `templates/product.product-identity.json`, `sections/athoor-tasting-notes.liquid` | the 30-day return-policy change — its own release, its own approval |

Two assertions fail if `theme-push/` ever widens to carry either group.

## Guards that must pass before and during the push

| Guard | What it catches |
|---|---|
| approved-path allowlist, no globs | a path nobody approved |
| theme role must be `main` | pushing to the draft and calling it success |
| drift check against the 31.1 backup | live changed since the diff was reviewed |
| render-dependency closure | **the 31.4 failure** — a staged file rendering an absent snippet |
| dynamic-bundle assertion | all 10 section bundles staged, despite being invisible to static scans |
| per-file verification, polled | Shopify serving a stale read after a PUT |
| JSON-aware verification | Shopify reformatting config JSON (an 8-byte diff that failed a correct write) |
| asset key-list hash before/after | this push ADDS 28 keys, so the list is expected to change by exactly 28 — a different delta means something else was created or deleted |

Note the last one is the one guard whose expectation changes: previous pushes required an
unchanged key list. This push adds 28 assets, so the check becomes "+28 and nothing else".

## Rollback

31.1 backup: `backups/live-180956594515/2026-08-30T22-21-36-919Z/`
`shasum -a 256 -c manifest.sha256` there reports OK for all seven files. For the 28 additive
files, rollback is deletion — they have no prior state.

## Database precondition — now SATISFIED

30.1 requires migrations to precede the push. As of this document they are applied and verified
on production: **22/22 migrations**, all 9 portal tables present, and the audit CHECK constraint
widened to include `customer_redaction`. Before this, production had only 15/22 and **none** of
the portal tables — so the portal would have failed on Birthday, Fragrance, Communication
preferences, Erasure requests and Wishlist removals.

## Still not authorised by this document

**31.6 — enabling the flag.** Separate step, separate decision, after the push is verified and
the 30.2 journey has actually been walked.

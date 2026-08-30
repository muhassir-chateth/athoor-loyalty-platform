# 31.4 — live push, the storefront breakage it caused, and the revised approval needed

**Live is fully restored.** All seven backed-up files are byte-identical to the 31.1 baseline,
388 assets, key-list `2b45b1bc0987b1fd`, 0 portal assets, and the homepage, a product page, a
collection and `/pages/rewards` all render with **0 Liquid errors**.

**31.4 is NOT complete, and needs a revised approval before it is retried.**

## What happened

The approved diff was two files. Both were pushed to live theme `180956594515`. The push was
byte-perfect — and it broke the storefront sitewide.

`sections/header.liquid` renders the snippet `portal-account-href`. That snippet is one of the
portal's 28 **additive** files, so it was not on live. Shopify does not fail quietly — it
renders the error into the attribute. Every page served this as the account link:

```
href="Liquid error (sections/header line 970): Could not find asset
      snippets/portal-account-href.liquid"
```

Confirmed on the homepage, `/collections/all`, `/products/identity` and `/pages/rewards`.

## Why my own checks did not catch it

This is the part worth keeping. Every guard passed, and the push was still wrong:

- per-file hash verification — **passed**, both files were written exactly as staged
- asset key-list hash — **passed**, no file created or deleted
- drift check against the 31.1 backup — **passed**, live had not changed
- the approved-paths allowlist — **passed**, only approved paths were touched

Correctness here is a property of **the set**, not of each file. Every file-level check can pass
while the set is unshippable. I had written the opposite into the approval artefact in my own
words — that the 28 additive files "carry no live counterpart, so they are not part of this
diff" — which is true about their *diff* and false about their *necessity*.

## Rollback

Restored `sections/header.liquid` from `backups/live-180956594515/2026-08-30T22-21-36-919Z/`, hash-verified against the manifest on read
2. Then returned `config/settings_schema.json` to the 22-group baseline as well, so live is not
left in a half-applied state nobody reviewed. The rehearsed 31.7 restore path was not theatre —
it worked exactly as rehearsed.

## A second defect, in the verifier

The first run reported `halted_verify_failed` on `config/settings_schema.json` after eight
polled reads. The write had **succeeded**: live held 23 groups, both setting ids, and content
semantically identical to the staged file — differing by **eight bytes**, because Shopify
reformats theme config JSON on write. `verifyStored()` now compares canonical JSON content for
`.json` assets and keeps strict byte equality for Liquid, with a test proving a genuinely
different JSON document is still rejected.

## The new guard

`portalLivePushDependencies.test.ts` computes, offline from git, every snippet each staged
Liquid file renders, and fails if one is new to live and not in the same push. Run against the
original two-file set it reproduces the incident verbatim:

```
sections/header.liquid renders 'portal-account-href' — new file, not in this push
```

## REVISED APPROVAL NEEDED — three files, not two

The transitive closure of `header.liquid`'s new dependencies is exactly one snippet:

| # | Path | Kind | Note |
|---|---|---|---|
| 1 | `config/settings_schema.json` | modified | 22 live groups preserved, one group appended |
| 2 | `sections/header.liquid` | modified | the two flag-gated account-link hunks, no a11y hunks |
| 3 | `snippets/portal-account-href.liquid` | **new** | the gate `header.liquid` renders; inert while the flag is off |

Item 3 is the only change from what you approved. With the flag off the snippet returns blank,
both account links fall through to the branches shipping today, and the rendered href is
byte-identical to current live — which is what the first push would have achieved had the
snippet been present.

The seven `aria-label` hunks remain **excluded**, per your instruction, for a separate release.

## Still blocked after that

**31.6 must not run yet** regardless of approval. Enabling the flag makes the portal reachable,
and the live theme still has none of the portal's templates or bundles, and the production
migrations are still unverified. Both must be resolved first.

# Task 31.3 — approval artefact: the exact production file list and diff

**Status: AWAITING OWNER APPROVAL. Nothing has been pushed to the live theme.**

31.3's approved artefact is "the diff of each staging file against the **live** file, with
the file list enumerated explicitly". That is this document. 31.4 must not run until it is
approved.

## The file list — exactly two files

Staged in `theme-push/`, each built from the **pulled live bytes** of theme
`180956594515` (snapshot `backups/live-180956594515/2026-08-30T21-38-37-883Z/`), never from the working tree.

| File | live bytes | staged bytes | live sha256 | staged sha256 |
|---|---|---|---|---|
| `config/settings_schema.json` | 40,016 | 41,003 | `48d01a6d1a115f8d` | `66698ea4426b9e47` |
| `sections/header.liquid` | 85,023 | 85,925 | `6fb229fa916dce31` | `4e83b615316ab943` |

No other file is pushed. The portal's other 28 theme files are **additive** and already
live on the draft theme only; they carry no live counterpart, so they are not part of this
diff. The push will use `--only=` with these two exact paths and no globs.

## Why `theme-push/` is not the working tree

The working tree's `sections/header.liquid` is **not safe to push**. Live and the working
tree differ by **five** hunks:

| Hunk | Concern | In this push? |
|---|---|---|
| menu-drawer account link → `portal-account-href` gate | **portal** (task 19.3) | yes |
| header account link → `portal-account-href` gate | **portal** (task 19.3) | yes |
| wishlist link `aria-label` | a11y (task 47) | **no** |
| compare link `aria-label` | a11y (task 47) | **no** |
| cart link `aria-label` | a11y (task 47) | **no** |
| account link `aria-label` + `account_link_label` liquid | a11y (task 47) — **same `<a>` tag as the portal hunk** | **no** |

The last one is a **mixed hunk**: the portal href gate and an unrelated a11y label sit on
the same tag. 31.2 requires that "if a portal hunk cannot be separated from an unrelated
local hunk, the file is not pushed and the unrelated change is resolved with the owner
first". It *was* separable, so the staged file carries the portal gate and **none** of the
a11y change — proved mechanically: staged `aria-label` count equals live's (19), staged
contains both portal renders, and `account_link_label` is absent. `portalProductionDiff.test.ts`
locks that, and it fails if anyone copies the working-tree file over the staged one.

## THE DECISION I NEED FROM YOU

**Two separate questions. Please answer both.**

**1. Approve this two-file portal diff for the live push (31.4)?**
With the flag off, `portal-account-href` renders blank, so both links fall through to the
branches that ship today and the rendered href is byte-identical to current live. The 22
existing settings groups are preserved byte-for-byte and one group is appended.

**2. What should happen to the seven `aria-label` additions?**
They are not portal work. Their in-file comment attributes them to task 47, fixing a
**serious** axe violation (WCAG 2.4.4 / 4.1.2) — the icon links have no discernible name
because `.icon__fallback-text` is hidden by CSS. Options:

- **(a) Leave them out** — this push stays portal-only. The live violation remains until a
  separate a11y release. *This is what is staged now.*
- **(b) Include them** — one extra hunk set in the same file, fixing a real accessibility
  defect, but it widens a portal release to carry unrelated work.
- **(c) Separate release** — ship the portal now, then the a11y fix as its own diff with
  its own approval and its own revert path.

I have not chosen for you: (a) is the specification-compliant default, but leaving a known
serious accessibility defect on live is a real cost, and only you can weigh that against
release hygiene.

## After approval

31.4 pushes `--only=config/settings_schema.json,sections/header.liquid` from `theme-push/`.
31.5 re-reads both files from live and hash-compares against the staged sha256 above,
treating any mismatch as a failed deployment requiring restore from the 31.1 backup.
31.6 keeps the flag off and stages the rollout through `portal_allowlist` first.

## Rollback

31.1 captured both files byte-exactly before any change:

```
backups/live-180956594515/2026-08-30T21-38-37-883Z/config/settings_schema.json   sha256 48d01a6d1a115f8d20d8a7dcae1c82577ac6b8c9b83e53413a1c796d746b60e3
backups/live-180956594515/2026-08-30T21-38-37-883Z/sections/header.liquid        sha256 6fb229fa916dce311dce32b1b0ed0505b54240b5e9544ba3664d94c6374958c5
```

Restoring either is a single asset write of those bytes followed by a hash re-check.

---

## Appendix — the full diffs

### `config/settings_schema.json`

```diff
--- backups/live-180956594515/2026-08-30T21-38-37-883Z/config/settings_schema.json	2026-08-30 22:38:38
+++ theme-push/config/settings_schema.json	2026-08-30 22:54:42
@@ -4,8 +4,8 @@
     "theme_name": "Lilac",
     "theme_version": "1.2",
     "theme_author": "Wedesigntech",
-    "theme_documentation_url": "https:\/\/help.shopify.com\/manual\/online-store\/themes",
-    "theme_support_url": "https:\/\/support.shopify.com\/"
+    "theme_documentation_url": "https://help.shopify.com/manual/online-store/themes",
+    "theme_support_url": "https://support.shopify.com/"
   },
   {
     "name": "t:settings_schema.colors.name",
@@ -1433,6 +1433,32 @@
         "id": "cart_drawer_collection",
         "label": "t:settings_schema.cart.settings.cart_drawer.collection.label",
         "info": "t:settings_schema.cart.settings.cart_drawer.collection.info"
+      }
+    ]
+  },
+  {
+    "name": "My Athoor Portal",
+    "settings": [
+      {
+        "type": "header",
+        "content": "Customer experience portal"
+      },
+      {
+        "type": "paragraph",
+        "content": "The portal is deployed but hidden until this is switched on. With it off, every page renders exactly as it does today and no portal markup, stylesheet or script is emitted."
+      },
+      {
+        "type": "checkbox",
+        "id": "portal_enabled",
+        "default": false,
+        "label": "Show the My Athoor portal to everyone",
+        "info": "Turn on to release the portal to all signed-in customers. Leave off to keep using the allowlist below for a staged rollout."
+      },
+      {
+        "type": "textarea",
+        "id": "portal_allowlist",
+        "label": "Staged rollout: customer IDs",
+        "info": "Comma-separated numeric customer IDs. These customers see the portal while it is still hidden from everyone else. Ignored once the switch above is on."
       }
     ]
   }
```

### `sections/header.liquid`

```diff
--- backups/live-180956594515/2026-08-30T21-38-37-883Z/sections/header.liquid	2026-08-30 22:38:38
+++ theme-push/sections/header.liquid	2026-08-30 22:55:34
@@ -348,7 +348,9 @@
                   </nav>
                 <div class="menu-drawer__utility-links">
                   {%- if shop.customer_accounts_enabled -%}
-                    <a href="{%- if customer -%}{{ routes.account_url }}{%- else -%}{{ routes.account_login_url }}{%- endif -%}" class="menu-drawer__account link focus-inset h5">
+                    {%- capture portal_drawer_href -%}{% render 'portal-account-href' %}{%- endcapture -%}
+                    {%- assign portal_drawer_href = portal_drawer_href | strip -%}
+                    <a href="{%- if portal_drawer_href != blank -%}{{ portal_drawer_href }}{%- elsif customer -%}{{ routes.account_url }}{%- else -%}{{ routes.account_login_url }}{%- endif -%}" class="menu-drawer__account link focus-inset h5">
                       {% render 'icon-account' %}
                       {%- liquid
                         if customer
@@ -959,7 +961,15 @@
  {%- endif -%}
                  
      {%- if shop.customer_accounts_enabled and section.settings.show_account -%}
-        <a href="{%- if customer -%}{{ routes.account_url }}{%- else -%}/pages/account-landing{%- endif -%}"{% unless customer %} data-account-drawer-open{% endunless %} class="header__icon header__icon--account link focus-inset{% if section.settings.menu != blank %} small-hide{% endif %}">
+        {%- comment -%}
+          Task 19.3, design §25.3: the ONE flag-gated live-theme change. With the portal
+          off `portal_account_href` is blank and the two branches below are the ones that
+          shipped before, so the rendered href is byte-identical to today's. The gate lives
+          in `portal-account-href` so it cannot drift from the one the portal pages use.
+        {%- endcomment -%}
+        {%- capture portal_account_href -%}{% render 'portal-account-href' %}{%- endcapture -%}
+        {%- assign portal_account_href = portal_account_href | strip -%}
+        <a href="{%- if portal_account_href != blank -%}{{ portal_account_href }}{%- elsif customer -%}{{ routes.account_url }}{%- else -%}/pages/account-landing{%- endif -%}"{% unless customer %} data-account-drawer-open{% endunless %} class="header__icon header__icon--account link focus-inset{% if section.settings.menu != blank %} small-hide{% endif %}">
           {% render 'icon-account' %}
           <span class="icon__fallback-text">
             {%- liquid
```

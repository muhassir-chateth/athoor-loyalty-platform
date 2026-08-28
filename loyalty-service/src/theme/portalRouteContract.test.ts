/**
 * THE PORTAL ROUTE CONTRACT — the Shopify Page-object half of §17.2.
 *
 * ── WHY THIS GATE EXISTS ────────────────────────────────────────────────────
 * A Shopify storefront URL `/pages/<handle>` resolves only when TWO independent
 * things line up:
 *
 *   1. a **Page resource** exists in the store with that handle, and
 *   2. that Page's `template_suffix` names a template present in the theme.
 *
 * The theme half lives in this repository. The Page half is store-level data —
 * it is not in git, not in the theme, and not created by any task in the plan.
 * Design §17.2 lists the routes as "new page templates" and stops there, so the
 * Page objects are an unowned prerequisite. This gate makes the repository state
 * the authoritative statement of what the owner must create, and fails when the
 * two halves drift.
 *
 * ── THE DEFECT THIS WOULD HAVE CAUGHT ───────────────────────────────────────
 * Nothing in the suite currently connects a navigation href to a template file.
 * A link to `/pages/my-athoor-loyalty` with no `page.my-athoor-loyalty.liquid`
 * is a **live 404 reachable from the portal's own navigation** — and every
 * existing test would stay green, because the nav snippet renders the href
 * perfectly and the DOM tests never resolve it. Equally, a template nobody links
 * to is a route the owner would be told to create a Page for that no user can
 * reach.
 *
 * ── SCOPE: SHIPPED THEME CODE ONLY ──────────────────────────────────────────
 * The scan covers `theme/` — the bytes Shopify serves, built bundles included.
 * It deliberately excludes `loyalty-service/src`, because a test fixture there
 * legitimately holds the *prefix* `/pages/my-athoor-` for runtime construction,
 * and treating that as a route reference would make this gate assert against a
 * URL no visitor ever requests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const THEME_DIR = join(REPO_ROOT, "theme");
const TEMPLATES_DIR = join(THEME_DIR, "templates");

/**
 * The Page objects the owner must create, pinned.
 *
 * Pinned rather than derived-and-compared-to-itself so that adding an eleventh
 * portal template is a *deliberate* act: the derived set stops matching this
 * list, this gate fails, and whoever added the template has to extend the
 * owner's Page-creation checklist in the same change. A gate that derived both
 * sides would agree with itself forever and tell the owner nothing.
 */
const REQUIRED_PAGE_HANDLES: readonly string[] = [
  "my-athoor",
  "my-athoor-activity",
  "my-athoor-fragrance",
  "my-athoor-order-detail",
  "my-athoor-orders",
  "my-athoor-profile",
  "my-athoor-referrals",
  "my-athoor-rewards",
  "my-athoor-settings",
  "my-athoor-wishlist",
];

/** Every portal page template, as `page.<suffix>.liquid`. */
function portalTemplateSuffixes(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => name.startsWith("page.my-athoor") && name.endsWith(".liquid"))
    .map((name) => name.slice("page.".length, -".liquid".length))
    .sort();
}

/** Recursively collect every file under `theme/`. */
function themeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) themeFiles(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every `/pages/my-athoor…` reference in shipped theme bytes, mapped to the
 * files that contain it.
 *
 * The trailing `[a-z0-9-]*` is greedy on purpose: it captures a *malformed*
 * handle too, so a typo like `/pages/my-athoor-reward` surfaces as an unmatched
 * reference rather than being silently trimmed to something that does match.
 */
function referencedHandles(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of themeFiles(THEME_DIR)) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable asset; no URLs to find
    }
    for (const match of body.matchAll(/\/pages\/(my-athoor[a-z0-9-]*)/g)) {
      const handle = match[1];
      const where = found.get(handle) ?? [];
      const rel = relative(REPO_ROOT, file);
      if (!where.includes(rel)) where.push(rel);
      found.set(handle, where);
    }
  }
  return found;
}

describe("portal route contract: templates, links and required Page objects", () => {
  it("ships exactly the ten portal page templates the owner checklist names", () => {
    expect(portalTemplateSuffixes()).toEqual([...REQUIRED_PAGE_HANDLES].sort());
  });

  it("requires one Page handle per template, with handle === template suffix", () => {
    // Not a tautology: it fixes the *rule* that produces the owner checklist.
    // If a template were ever named `page.myathoor-orders.liquid`, the handle the
    // owner must create changes with it, and a checklist derived by a different
    // rule elsewhere would send them to create the wrong Page.
    for (const suffix of portalTemplateSuffixes()) {
      expect(REQUIRED_PAGE_HANDLES).toContain(suffix);
    }
    expect(new Set(REQUIRED_PAGE_HANDLES).size).toBe(REQUIRED_PAGE_HANDLES.length);
  });

  it("has a template for every portal URL the shipped theme links to", () => {
    const templates = new Set(portalTemplateSuffixes());
    const broken: string[] = [];
    for (const [handle, files] of referencedHandles()) {
      if (!templates.has(handle)) broken.push(`/pages/${handle} <- ${files.join(", ")}`);
    }
    expect(broken, "portal URLs linked from the theme with no matching template").toEqual([]);
  });

  it("links every portal template from somewhere in the theme", () => {
    // An unlinked template is a route the owner is asked to create a Page for
    // that no navigation reaches — dead weight in the deployment, and a sign a
    // nav entry was dropped.
    const referenced = new Set(referencedHandles().keys());
    const orphans = portalTemplateSuffixes().filter((s) => !referenced.has(s));
    expect(orphans, "portal templates no shipped theme file links to").toEqual([]);
  });

  it("never links a portal URL that is only a runtime-constructed prefix", () => {
    // `/pages/my-athoor-` with nothing after it means a bundle is building the
    // handle by concatenation. In shipped theme bytes that is a latent 404: the
    // suffix comes from data, so no static check can prove it resolves.
    const bare = [...referencedHandles().entries()].filter(([h]) => h.endsWith("-"));
    expect(
      bare.map(([h, f]) => `${h} <- ${f.join(", ")}`),
      "a shipped theme file builds a portal URL by concatenation",
    ).toEqual([]);
  });
});

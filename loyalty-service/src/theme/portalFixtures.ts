/**
 * `portalFixtures.ts` — the shared section fixtures the task 29 gates run against.
 *
 * NOT A TEST. A helper, so the accessibility gates (29.1, 29.2), the
 * forbidden-strings gate (29.3) and the bundle smoke test (29.12) all inspect the
 * SAME markup rather than three transcriptions of it that can drift apart.
 *
 * ── THE MARKUP IS EXTRACTED, NEVER TRANSCRIBED ──────────────────────────────
 * Every fixture is read out of `theme/snippets/portal-section.liquid` at run time
 * and its Liquid stripped. Task 24's non-vacuity run proved the cost of the
 * alternative: a hand-written markup constant cannot see an attribute change in the
 * file that actually ships, so the suite stayed green while the shipped template
 * carried the defect. A gate built on a transcription is a gate that verifies the
 * transcription.
 *
 * ── WHY THE LIQUID STRIPPING IS CONSERVATIVE ────────────────────────────────
 * Only three constructs are handled: comments are removed, `{%- if -%}` /
 * `{%- else -%}` branches are resolved to the truthy arm, and `{{ object.field }}`
 * interpolations become a sample value. Anything else would be re-implementing a
 * Liquid engine, and a wrong one would make these gates assert against markup
 * Shopify never renders. The three are enough because §25.6 keeps the portal's own
 * templates deliberately logic-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repository root, from this file's location. */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SNIPPET = join(ROOT, "theme", "snippets", "portal-section.liquid");

/** The ten Portal_Sections, in the order the `case` declares them. */
export const SECTION_NAMES: readonly string[] = [
  "orders",
  "order-detail",
  "wishlist",
  "activity",
  "rewards",
  "profile",
  "overview",
  "fragrance",
  "referrals",
  "settings",
];

/** §18.8's eight designed states. */
export const STATE_NAMES: readonly string[] = [
  "loading",
  "empty",
  "ready",
  "error",
  "disabled",
  "offline",
  "session-expired",
  "degraded",
];

/** Sample values for the handful of Liquid objects the portal templates read. */
const LIQUID_VALUES: Readonly<Record<string, string>> = {
  "customer.first_name": "Layla",
  "routes.account_logout_url": "/account/logout",
  "page_title": "Your account",
};

/** One section's arm, verbatim, including its Liquid. */
export function armSource(section: string): string {
  const whole = readFileSync(SNIPPET, "utf8");
  const marker = `{%- when '${section}' -%}`;
  const start = whole.indexOf(marker);
  if (start < 0) throw new Error(`no Liquid arm for section "${section}"`);
  const afterMarker = start + marker.length;
  const nextArm = whole.indexOf("{%- when ", afterMarker);
  const endCase = whole.indexOf("{%- endcase -%}", afterMarker);
  // The last arm has no following `when`, so it ends at `endcase`.
  const end = nextArm === -1 ? endCase : Math.min(nextArm, endCase === -1 ? nextArm : endCase);
  return whole.slice(afterMarker, end === -1 ? undefined : end);
}

/** The arm with its Liquid resolved to a renderable approximation. */
export function armMarkup(section: string): string {
  let arm = armSource(section);
  // 1. Comments.
  arm = arm.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
  // 2. Conditionals — take the truthy arm, which is the state a signed-in customer
  //    with data sees and therefore the one worth auditing.
  arm = arm.replace(
    /\{%-?\s*if\s+[^%]*?-?%\}([\s\S]*?)\{%-?\s*else\s*-?%\}[\s\S]*?\{%-?\s*endif\s*-?%\}/g,
    (_all, truthy: string) => truthy,
  );
  arm = arm.replace(/\{%-?\s*if\s+[^%]*?-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g, (_all, body: string) => body);
  // 3. Interpolations.
  arm = arm.replace(/\{\{\s*([A-Za-z0-9_.]+)[^}]*\}\}/g, (_all, name: string) => {
    const known = Object.prototype.hasOwnProperty.call(LIQUID_VALUES, name)
      ? LIQUID_VALUES[name]
      : undefined;
    return typeof known === "string" ? known : "Sample";
  });
  // Anything left is a Liquid tag this helper does not model; removing it is safer
  // than leaving `{%` in the DOM, where it would read as text content.
  arm = arm.replace(/\{%-?[\s\S]*?-?%\}/g, "");
  return arm;
}

/**
 * A whole section, wrapped in the shared scaffold `portal-section.liquid` emits.
 *
 * The wrapper is reproduced here rather than extracted because it sits OUTSIDE the
 * `case` and is one fixed block; extracting it would mean parsing around the `case`
 * itself for no benefit.
 */
export function sectionHtml(section: string, state = "ready"): string {
  const busy = state === "loading" ? ' aria-busy="true"' : "";
  return `
    <div class="athoor-portal" data-portal-root>
      <a class="athoor-portal__skip" href="#AthoorPortalContent">Skip to your account</a>
      <p class="athoor-portal__live" data-portal-live-global role="status" aria-live="polite"></p>
      <header class="athoor-portal__header">
        <p class="athoor-portal__wordmark">MY ATHOOR</p>
        <h1 class="athoor-portal__title">Your account</h1>
      </header>
      <div class="athoor-portal__body">
        <nav class="athoor-portal__nav" aria-label="Your account">
          <ul class="athoor-portal__nav-list">
            <li class="athoor-portal__nav-item"><a class="athoor-portal__nav-link" href="/pages/my-athoor">Overview</a></li>
          </ul>
        </nav>
        <div class="athoor-portal__content" id="AthoorPortalContent" tabindex="-1">
          <section class="athoor-portal__section" data-portal-section="${section}" data-state="${state}"${busy}>
            <p class="athoor-portal__live" data-portal-live aria-live="polite"></p>
            <div class="athoor-portal__state">
              <p class="athoor-portal__state-message" data-portal-state-message>Preparing your account</p>
              <p class="athoor-portal__state-reference" data-portal-reference hidden></p>
              <button class="athoor-portal__retry" type="button" data-portal-retry hidden>Try again</button>
            </div>
            <div class="athoor-portal__skeleton" data-portal-skeleton aria-hidden="true">
              <div class="athoor-portal__skeleton-row"></div>
            </div>
            <div class="athoor-portal__section-body" data-portal-body></div>
            ${armMarkup(section)}
          </section>
        </div>
      </div>
      <footer class="athoor-portal__footer">
        <a class="athoor-portal__footer-link" href="/account/logout">Sign out</a>
      </footer>
    </div>`;
}

/** Every built portal asset path, so a gate can scan or boot them. */
export function builtAssets(): readonly string[] {
  const dir = join(ROOT, "theme", "assets");
  return [
    "athoor-portal-core.js",
    ...SECTION_NAMES.map((name) => `athoor-portal-${name}.js`),
    "athoor-portal.css",
  ].map((name) => join(dir, name));
}

/** Every Liquid file the portal owns. */
export function portalLiquidFiles(): readonly string[] {
  const snippets = join(ROOT, "theme", "snippets");
  const templates = join(ROOT, "theme", "templates");
  return [
    join(snippets, "portal-section.liquid"),
    join(snippets, "portal-chrome.liquid"),
    join(snippets, "portal-nav.liquid"),
    join(snippets, "portal-more-sheet.liquid"),
    join(snippets, "portal-signin-invitation.liquid"),
    join(snippets, "portal-account-href.liquid"),
    join(templates, "page.my-athoor.liquid"),
    ...SECTION_NAMES.filter((name) => name !== "overview").map((name) =>
      join(templates, `page.my-athoor-${name}.liquid`),
    ),
  ];
}

export { ROOT as REPO_ROOT };

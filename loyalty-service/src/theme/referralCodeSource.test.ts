/**
 * Theme regression test — the referral code shown to a member must be REAL
 * (task 34, audit finding F3).
 *
 * WHAT WAS WRONG: `theme/sections/loyalty-dashboard.liquid` rendered
 * `customer.metafields.loyalty.referral_code` and, when that metafield was
 * absent, FABRICATED a code from the customer's first name and Shopify id:
 *
 *     ATHOOR-{{ customer.first_name | upcase | truncate: 4, '' }}{{ customer.id | modulo: 9999 }}
 *
 * The metafield existed on no staging customer, so every member was shown an
 * invented code (`ATHOOR-REF3347` for a member whose real code is
 * `ATH-6JX5-CJQJ`). A referral claimed with a fabricated code credits nobody.
 *
 * This test reads the theme SOURCE TEXT — the same infrastructure-free approach
 * as `boot.wiring.test.ts` — and asserts:
 *   - no fabrication pattern survives anywhere in `theme/`;
 *   - the dashboard renders a localized placeholder instead, marked pending;
 *   - the copy control cannot copy a placeholder;
 *   - `athoor-loyalty.js` actually calls `/v1/referral` and writes `referralCode`.
 *
 * SCOPE LIMIT, stated plainly: this is a STATIC check of repository files. The
 * staging storefront is password-protected (`302 → /password`) and the staging
 * Admin token lacks `read_themes`, so the rendered page and the browser
 * behaviour of these changes are NOT runtime-validated by this or any other test.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** repo-root/theme (this file lives at repo-root/loyalty-service/src/theme). */
const THEME_DIR = join(__dirname, "..", "..", "..", "theme");

const DASHBOARD = join(THEME_DIR, "sections", "loyalty-dashboard.liquid");
const SCRIPT = join(THEME_DIR, "assets", "athoor-loyalty.js");
const LOCALE = join(THEME_DIR, "locales", "en.default.json");

/** Every file in `theme/`, so the fabrication cannot hide in an unexpected one. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const themeFiles = walk(THEME_DIR);
const dashboardSource = readFileSync(DASHBOARD, "utf8");
const scriptSource = readFileSync(SCRIPT, "utf8");
const localeSource = readFileSync(LOCALE, "utf8");

/**
 * Patterns that would mean an invented referral value is still being rendered.
 * Each is checked against EVERY file in the theme, not just the dashboard.
 */
const FABRICATION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "the ATHOOR- code prefix", pattern: /ATHOOR-/ },
  { label: "the customer.id modulo trick", pattern: /customer\.id\s*\|\s*modulo/ },
  { label: "any modulo of an id into displayed output", pattern: /\|\s*modulo:\s*9999/ },
  { label: "first_name spliced into a code", pattern: /first_name[^\n]*truncate:\s*4/ },
];

describe("no fabricated referral code survives in theme/ (task 34, F3)", () => {
  it.each(FABRICATION_PATTERNS)("no file in theme/ contains $label", ({ pattern }) => {
    const offenders = themeFiles
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(THEME_DIR, file));

    expect(offenders).toEqual([]);
  });

  it("scanned a plausible theme tree (guards against the walk silently finding nothing)", () => {
    expect(themeFiles.length).toBeGreaterThan(20);
    expect(themeFiles).toContain(DASHBOARD);
  });
});

describe("the dashboard renders an honest referral state instead", () => {
  it("still renders the real cached metafield when it exists", () => {
    expect(dashboardSource).toMatch(/customer\.metafields\.loyalty\.referral_code\.value/);
  });

  it("falls back to a LOCALIZED placeholder, not a code-shaped value", () => {
    expect(dashboardSource).toMatch(/'loyalty\.referral\.code_pending'\s*\|\s*t/);
    // The copy is externalised through the locale files, not hardcoded English.
    expect(localeSource).toMatch(/"code_pending"\s*:/);
  });

  it("marks the placeholder as pending so nothing can mistake it for a code", () => {
    expect(dashboardSource).toMatch(/data-loyalty-code-pending/);
  });

  it("disables the copy control while there is no real code", () => {
    expect(dashboardSource).toMatch(/referral_code\s*==\s*blank\s*%\}\s*disabled/);
  });

  it("refuses to copy while the pending flag is set (defence in depth)", () => {
    expect(dashboardSource).toMatch(
      /hasAttribute\(\s*'data-loyalty-code-pending'\s*\)\s*\)\s*\{\s*return;/,
    );
  });
});

describe("athoor-loyalty.js sources the code from /v1/referral", () => {
  it("fetches /v1/referral", () => {
    expect(scriptSource).toMatch(/fetchJson\(\s*proxyBase \+ '\/v1\/referral'\s*\)/);
  });

  it("goes through fetchJson, so it inherits the AbortController timeout", () => {
    // loadReferral must not hand-roll its own fetch: the shared helper is what
    // applies the 3s hard timeout and the silent fallback (Req 8.4).
    const loadReferral = /function loadReferral\(\)[\s\S]*?\n  \}/.exec(scriptSource)?.[0] ?? "";
    expect(loadReferral).not.toBe("");
    expect(loadReferral).toMatch(/fetchJson\(/);
    expect(loadReferral).not.toMatch(/window\.fetch\(/);
    expect(loadReferral).toMatch(/\.catch\(noop\)/);
  });

  it("writes the API's referralCode into the referral element", () => {
    expect(scriptSource).toMatch(/data\.referralCode/);
    expect(scriptSource).toMatch(/\[data-loyalty="referral-code"\]/);
  });

  it("only enables the copy control after writing a real, non-empty code", () => {
    const apply = /function applyReferralCode\(code\)[\s\S]*?\n  \}/.exec(scriptSource)?.[0] ?? "";
    expect(apply).toMatch(/removeAttribute\('data-loyalty-code-pending'\)/);
    expect(apply).toMatch(/removeAttribute\('disabled'\)/);
    // The guard that keeps applyReferralCode from ever seeing an empty string.
    expect(scriptSource).toMatch(/if \(code\) applyReferralCode\(code\)/);
  });

  it("invents no referral value of its own", () => {
    expect(scriptSource).not.toMatch(/ATHOOR-/);
  });
});

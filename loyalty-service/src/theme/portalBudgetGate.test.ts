/**
 * TASK 29.11 — the bundle budget gate, plus `defer` and the third-party prohibition.
 * Validates Requirements 18.3, 18.4, 25.3.
 *
 * ── DIVISION OF LABOUR WITH THE BUILD SCRIPT ─────────────────────────────────
 * The SIZE gate lives in `scripts/build/portal-assets.mjs`, because it must fail the
 * build before the artefacts are written — an over-budget bundle that reached
 * `theme/assets/` could be approved by the scoped push of §25.5 before anyone
 * measured it. This file asserts that the gate exists, is wired into both build
 * modes, and has not been quietly relaxed; and it owns the two checks that are
 * properties of the THEME rather than of the bundles: `defer`, and the absence of any
 * new third-party origin.
 *
 * A budget constant is the easiest thing in a repository to raise. Asserting the
 * numbers here means raising one is a two-file change with a visible diff, rather
 * than a one-character edit in a build script nobody reads.
 *
 * SAFETY: file reads only. No network, no database, no build invocation.
 */
import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, SECTION_NAMES, builtAssets, portalLiquidFiles } from "./portalFixtures.js";

const BUILD_SCRIPT = readFileSync(
  join(REPO_ROOT, "loyalty-service", "scripts", "build", "portal-assets.mjs"),
  "utf8",
);

/** Requirement 18.3's two numbers, in bytes. */
const BUDGET_JS_PER_PAGE = 40 * 1024;
const BUDGET_CSS = 20 * 1024;

function sizes(bytes: Buffer): { raw: number; gzip: number; brotli: number } {
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

function asset(name: string): Buffer {
  return readFileSync(join(REPO_ROOT, "theme", "assets", name));
}

const kb = (n: number): string => `${(n / 1024).toFixed(2)} KB`;

/* ══════════════════════════════════════════════════════════════════════════ *
 * The budget, measured here as well as enforced in the build
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Task 29.11 — the bundle budget (Requirement 18.3)", () => {
  const core = sizes(asset("athoor-portal-core.js"));

  for (const section of SECTION_NAMES) {
    it(`the ${section} page fits the 40 KB compressed JavaScript budget`, () => {
      // Measured independently of the build script, over the COMMITTED artefacts —
      // which are the bytes Shopify serves. If the build script's gate were removed,
      // this would still catch an over-budget page.
      const bundle = sizes(asset(`athoor-portal-${section}.js`));
      const pageGzip = core.gzip + bundle.gzip;
      const pageBrotli = core.brotli + bundle.brotli;
      expect(
        pageGzip,
        `${section}: ${kb(pageGzip)} gzip (core ${kb(core.gzip)} + section ${kb(bundle.gzip)})`,
      ).toBeLessThanOrEqual(BUDGET_JS_PER_PAGE);
      expect(pageBrotli).toBeLessThanOrEqual(BUDGET_JS_PER_PAGE);
    });
  }

  it("the stylesheet fits the 20 KB compressed CSS budget", () => {
    const css = sizes(asset("athoor-portal.css"));
    expect(css.gzip, `stylesheet is ${kb(css.gzip)} gzip`).toBeLessThanOrEqual(BUDGET_CSS);
    expect(css.brotli).toBeLessThanOrEqual(BUDGET_CSS);
  });

  it("the build script's budget constants are the numbers Requirement 18.3 states", () => {
    // A budget constant is the easiest thing here to raise. Pinning it means a change
    // shows up in two files.
    expect(BUILD_SCRIPT).toMatch(/const BUDGET_JS_PER_PAGE = 40 \* 1024;/);
    expect(BUILD_SCRIPT).toMatch(/const BUDGET_CSS = 20 \* 1024;/);
  });

  it("the build script FAILS on a violation, in both build modes", () => {
    // The wiring, asserted structurally. `budgetViolations()` must exist, must be
    // called from `main()`, and must set a non-zero exit — and the call must sit
    // BEFORE the `--check`/`emit` branch, so neither mode can skip it.
    expect(BUILD_SCRIPT).toMatch(/function budgetViolations\(/);
    const mainBody = /async function main\(\)\s*\{([\s\S]*?)\n\}/.exec(BUILD_SCRIPT)?.[1] ?? "";
    expect(mainBody, "main() does not call budgetViolations()").toMatch(/budgetViolations\(/);
    expect(mainBody).toMatch(/process\.exitCode = 1/);
    // Ordering: the gate must precede the write, or a failing build still leaves an
    // over-budget artefact on disk for the scoped push of §25.5 to approve.
    const gateAt = mainBody.indexOf("budgetViolations(");
    const emitAt = mainBody.indexOf("emit(artefacts)");
    const checkAt = mainBody.indexOf("check(artefacts)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(-1);
    expect(gateAt, "the budget gate runs after the write").toBeLessThan(emitAt);
    expect(gateAt, "the budget gate runs after --check").toBeLessThan(checkAt);
  });

  it("the gate checks EVERY section page and both codecs, not only the worst", () => {
    const gateBody = /function budgetViolations\(artefacts\)\s*\{([\s\S]*?)\n\}/.exec(BUILD_SCRIPT)?.[1] ?? "";
    expect(gateBody).not.toBe("");
    // A loop over sections rather than a single `sort()[0]`.
    expect(gateBody).toMatch(/for\s*\(\s*const\s+section\s+of\s+sections\s*\)/);
    expect(gateBody).toMatch(/for\s*\(\s*const\s+codec\s+of\s+\["gzip",\s*"brotli"\]\s*\)/);
    // And it must still check the CSS.
    expect(gateBody).toMatch(/BUDGET_CSS/);
    expect(gateBody).toMatch(/BUDGET_JS_PER_PAGE/);
  });

  it("the script no longer describes its own sizes as unenforced", () => {
    // The line this task removed. Left in place it would be false, and a false comment
    // about whether a gate is a gate is worse than no comment.
    expect(BUILD_SCRIPT).not.toContain("REPORTED, not enforced");
    expect(BUILD_SCRIPT).not.toContain("The build-failing budget gate is task 29.11");
  });

  it("is NON-VACUOUS: the measurement is real and the budget is not unreachable", () => {
    // A budget nothing could ever exceed is not a constraint. The largest page is a
    // real fraction of it, and the compression really is compressing.
    const profile = sizes(asset("athoor-portal-profile.js"));
    expect(profile.gzip).toBeGreaterThan(0);
    expect(profile.gzip).toBeLessThan(profile.raw);
    expect(profile.brotli).toBeLessThanOrEqual(profile.gzip);
    // Every artefact the fixtures list must actually exist and be non-empty, or the
    // per-section assertions above would be measuring nothing.
    for (const path of builtAssets()) {
      expect(readFileSync(path).byteLength, `${path} is empty`).toBeGreaterThan(0);
    }
    // And a synthetic over-budget page must be recognised as over budget.
    expect(core.gzip + 40 * 1024).toBeGreaterThan(BUDGET_JS_PER_PAGE);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * `defer` on every portal script (Requirement 18.4)
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Task 29.11 — every portal script is deferred (Requirement 18.4)", () => {
  /** Every `<script>` tag in the portal's Liquid, as raw text. */
  function scriptTags(): { path: string; tag: string }[] {
    const found: { path: string; tag: string }[] = [];
    for (const path of portalLiquidFiles()) {
      const text = readFileSync(path, "utf8").replace(
        /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
        "",
      );
      for (const match of text.matchAll(/<script\b[^>]*>/gi)) {
        found.push({ path, tag: match[0].replace(/\s+/g, " ") });
      }
    }
    return found;
  }

  it("every portal <script> carries defer, and none is synchronous", () => {
    const tags = scriptTags();
    // There must BE scripts, or "all deferred" is vacuous.
    expect(tags.length, "the portal renders no <script> at all").toBeGreaterThan(0);
    const offenders = tags
      .filter((entry) => !/\bdefer\b/i.test(entry.tag))
      .map((entry) => `${entry.path}: ${entry.tag}`);
    expect(offenders, `portal scripts without defer:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no portal script uses async, which would not preserve core-before-section order", () => {
    // `defer` keeps document order; `async` does not. A section bundle that ran before
    // core would find no `window.AthoorPortal` and register nothing — a section that is
    // silently inert, which is the worst kind of failure to diagnose.
    const offenders = scriptTags()
      .filter((entry) => /\basync\b/i.test(entry.tag))
      .map((entry) => `${entry.path}: ${entry.tag}`);
    expect(offenders, `portal scripts using async:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the core script is emitted before the section script", () => {
    // The order `defer` preserves has to be the right order to begin with.
    const chrome = readFileSync(join(REPO_ROOT, "theme", "snippets", "portal-chrome.liquid"), "utf8");
    const coreAt = chrome.indexOf("athoor-portal-core.js");
    const sectionAt = chrome.indexOf("'athoor-portal-' | append: section_name");
    expect(coreAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeGreaterThan(-1);
    expect(coreAt, "the section bundle is emitted before core").toBeLessThan(sectionAt);
  });

  it("is NON-VACUOUS: the tag scan distinguishes deferred from synchronous", () => {
    const deferred = '<script src="x.js" defer="defer"></script>';
    const sync = '<script src="x.js"></script>';
    const asyncTag = '<script src="x.js" async></script>';
    expect(/\bdefer\b/i.test(deferred)).toBe(true);
    expect(/\bdefer\b/i.test(sync)).toBe(false);
    expect(/\basync\b/i.test(asyncTag)).toBe(true);
    expect(/\basync\b/i.test(deferred)).toBe(false);
    // And the extractor finds a tag at all.
    expect([...`${sync}${deferred}`.matchAll(/<script\b[^>]*>/gi)]).toHaveLength(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * No new third-party origin, font request or icon CDN (Requirement 25.3)
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Task 29.11 — no new third-party request (Requirement 25.3)", () => {
  /**
   * The CDNs the existing theme already uses, and which the portal must not join.
   *
   * `layout/theme.liquid` already loads Font Awesome and GSAP from cdnjs, both
   * render-blocking. Those are pre-existing and outside this project's file list. The
   * point of this gate is that the PORTAL adds no more of them.
   */
  const THIRD_PARTY_HOSTS: readonly string[] = [
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "use.typekit.net",
    "use.fontawesome.com",
    "kit.fontawesome.com",
    "ajax.googleapis.com",
    "esm.sh",
    "skypack.dev",
    "code.jquery.com",
  ];

  function portalArtefacts(): { path: string; text: string }[] {
    return [...builtAssets(), ...portalLiquidFiles()].map((path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }));
  }

  it("no portal artefact references a third-party CDN", () => {
    const offenders: string[] = [];
    for (const { path, text } of portalArtefacts()) {
      for (const host of THIRD_PARTY_HOSTS) {
        if (text.includes(host)) offenders.push(`${path}: ${host}`);
      }
    }
    expect(offenders, `third-party hosts in portal artefacts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the portal makes ZERO font requests — no @font-face, no font import", () => {
    // §18.1 chose Georgia and the platform UI stack precisely so the portal costs no
    // font request at all. A single `@font-face` would undo that and cost a round trip
    // on the critical path, which is performance opportunity P1 in reverse.
    const css = readFileSync(join(REPO_ROOT, "theme", "assets", "athoor-portal.css"), "utf8");
    expect(css).not.toMatch(/@font-face/i);
    expect(css).not.toMatch(/@import\s+url\(/i);
    expect(css).not.toMatch(/https?:\/\//);
    // And the declared families must be the system stacks, not a webfont name.
    expect(css).toMatch(/Georgia/);
    expect(css).toMatch(/-apple-system|BlinkMacSystemFont/);
  });

  it("the portal loads no icon font and no icon sprite", () => {
    const offenders: string[] = [];
    for (const { path, text } of portalArtefacts()) {
      for (const pattern of [/font-?awesome/i, /material-icons/i, /\bfa-[a-z]/i, /feather-icons/i]) {
        if (pattern.test(text)) offenders.push(`${path}: ${pattern.source}`);
      }
    }
    expect(offenders, `icon dependencies in portal artefacts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no portal artefact preloads, prefetches or preconnects to anything", () => {
    // A resource hint is a request. Adding one to the portal's pages would change the
    // `<head>` asset behaviour §25.6 requires to stay as it is.
    const offenders: string[] = [];
    for (const { path, text } of portalArtefacts()) {
      for (const match of text.matchAll(/rel=["'](preload|prefetch|preconnect|dns-prefetch)["']/gi)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders, `resource hints in portal artefacts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("is NON-VACUOUS: the host list matches the CDNs the theme already uses elsewhere", () => {
    // The strongest available evidence that these needles match real markup: the
    // pre-existing `layout/theme.liquid` contains two of them. If the patterns were
    // mistyped, this would fail — and it also documents that the portal's cleanliness
    // is a deliberate contrast with the page it sits inside.
    const layout = readFileSync(join(REPO_ROOT, "theme", "layout", "theme.liquid"), "utf8");
    const present = THIRD_PARTY_HOSTS.filter((host) => layout.includes(host));
    expect(present, "no known CDN found in layout/theme.liquid — are the needles right?").toContain(
      "cdnjs.cloudflare.com",
    );
    // The portal's own artefacts contain none of them, which is the contrast.
    const portalHits = portalArtefacts().flatMap(({ text }) =>
      THIRD_PARTY_HOSTS.filter((host) => text.includes(host)),
    );
    expect(portalHits).toEqual([]);
  });
});

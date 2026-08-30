/**
 * DUMP THE REAL SECTION MARKUP SO A REAL BROWSER CAN MEASURE IT (task 30.3).
 *
 * 30.3 needs `document.documentElement.scrollWidth <= width` per section at eight widths.
 * jsdom cannot answer that — it has no layout engine, and 30.2 already refuses jsdom as
 * evidence for this gate.
 *
 * Chrome must NOT become a test dependency: task 29.10 pins the dependency set and CI has no
 * browser. So the split is deliberate — derivation stays HERE, in the suite, where
 * `sectionHtml` reads `theme/snippets/portal-section.liquid` at run time; measurement happens
 * in `scripts/theme/portal-width-pass.mjs`, outside CI. Reconstructing the markup inside that
 * script would have let the two drift, and a width pass measuring stale markup is worse than
 * none because it reports a pass.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, SECTION_NAMES, sectionHtml, builtAssets } from "./portalFixtures.js";

const OUT = join(REPO_ROOT, "loyalty-service", ".width-fixture");

/**
 * The REAL navigation, derived from `portal-nav.liquid`'s own declarations.
 *
 * `portal-section.liquid`'s scaffold carries a ONE-ITEM stub nav, so the first width pass could
 * not measure the five bottom-bar targets, the 44px minimum, or anything depending on the real
 * child count. The shipped nav is a Liquid `for` loop over eight `nav_items`, which needs Liquid
 * evaluation this harness does not do.
 *
 * So the list, the labels, the hrefs, the bar/overflow split and the markup shape are all PARSED
 * OUT OF the shipped snippet rather than written here. If someone reorders `nav_items`, renames a
 * label or changes the four-in-the-bar rule, this follows. Hand-writing the list would have
 * produced a fixture that measured beautifully and described markup that no longer ships.
 *
 * This is derived-not-rendered, and the width report says so.
 */
function realNavMarkup(): string {
  const src = readFileSync(join(REPO_ROOT, "theme", "snippets", "portal-nav.liquid"), "utf8");

  const itemsMatch = /assign nav_items = '([^']+)' \| split/.exec(src);
  expect(itemsMatch, "portal-nav.liquid must declare nav_items").not.toBeNull();
  const items = (itemsMatch?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  expect(items.length, "the shipped nav declares eight entries").toBe(8);

  // Each `when 'x'` block assigns a label and an href.
  const meta = new Map<string, { label: string; href: string }>();
  for (const m of src.matchAll(/when '([a-z-]+)'\s*assign label = '([^']*)'\s*assign href = '([^']*)'/g)) {
    meta.set(m[1] as string, { label: m[2] as string, href: m[3] as string });
  }
  for (const item of items) expect(meta.has(item), `${item} must have a label and href`).toBe(true);

  // The bar/overflow rule, also read from the file rather than assumed.
  const barMatch = /forloop\.index <= (\d+)/.exec(src);
  expect(barMatch, "the bar cutoff must be declared").not.toBeNull();
  const barCount = Number(barMatch?.[1] ?? 0);
  expect(barCount).toBe(4);

  const lis = items.map((item, i) => {
    const { label, href } = meta.get(item) as { label: string; href: string };
    const overflow = i + 1 <= barCount ? "" : " athoor-portal__nav-item--overflow";
    return `<li class="athoor-portal__nav-item${overflow}">` +
      `<a class="athoor-portal__nav-link" href="${href}">` +
      `<span class="athoor-portal__nav-label">${label}</span></a></li>`;
  });
  // The fifth bar target: a button, because it opens a dialog rather than navigating.
  lis.push('<li class="athoor-portal__nav-item athoor-portal__nav-item--more">' +
    '<button class="athoor-portal__nav-link athoor-portal__nav-link--more" type="button" ' +
    'data-portal-more-open aria-haspopup="dialog" aria-controls="AthoorPortalMore">' +
    '<span class="athoor-portal__nav-label">More</span></button></li>');

  return `<nav class="athoor-portal__nav" aria-label="Your account">` +
    `<ul class="athoor-portal__nav-list" role="list">${lis.join("")}</ul></nav>`;
}


describe("30.3 fixture dump for the real-browser width pass", () => {
  it("writes every section's ready-state markup plus the shipped stylesheet", () => {
    mkdirSync(OUT, { recursive: true });
    const sections: Record<string, string> = {};
    const nav = realNavMarkup();
    for (const name of SECTION_NAMES) {
      // Swap the scaffold's one-item stub for the real eight-entry nav plus More.
      const withStub = sectionHtml(name, "ready");
      const replaced = withStub.replace(/<nav class="athoor-portal__nav"[\s\S]*?<\/nav>/, nav);
      expect(replaced, `${name}: the stub nav must have been replaced`).not.toBe(withStub);
      sections[name] = replaced;
    }
    expect(Object.keys(sections).length, "all sections dumped").toBe(SECTION_NAMES.length);
    for (const [name, html] of Object.entries(sections)) {
      expect(html.length, `${name} markup must not be empty`).toBeGreaterThan(40);
      expect(html, `${name} must carry its section hook`).toContain(`data-portal-section="${name}"`);
      // Nine children INSIDE the nav: eight entries plus More. Counted within the <nav> only,
      // because sections also carry nav-item classes elsewhere (the More sheet repeats the four
      // overflow entries). Guards a silent regex miss in the injection above.
      const navBlock = /<nav class="athoor-portal__nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
      expect(navBlock.length, `${name} must contain a nav block`).toBeGreaterThan(0);
      // Count <li> ELEMENTS, not class-substring hits: the overflow and more items carry
      // `athoor-portal__nav-item athoor-portal__nav-item--overflow`, so a substring count returns
      // 14 for a correct nine-item nav. Counting the wrong thing looked exactly like a bug in the
      // markup rather than a bug in the assertion.
      expect(
        (navBlock.match(/<li class="athoor-portal__nav-item/g) ?? []).length,
        `${name} nav must carry eight entries plus More`,
      ).toBe(9);
    }
    // builtAssets() returns PATHS, and the stylesheet must be one of them — asserted so the
    // dump cannot start reading a file the build no longer ships.
    const cssPath = join(REPO_ROOT, "theme", "assets", "athoor-portal.css");
    expect(builtAssets(), "the stylesheet must be a shipped asset").toContain(cssPath);
    const css = readFileSync(cssPath, "utf8");
    expect(css.length).toBeGreaterThan(1000);
    writeFileSync(join(OUT, "sections.json"), JSON.stringify(sections, null, 2), "utf8");
    writeFileSync(join(OUT, "athoor-portal.css"), css, "utf8");
  });
});

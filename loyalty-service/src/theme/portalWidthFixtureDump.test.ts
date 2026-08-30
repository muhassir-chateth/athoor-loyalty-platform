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

describe("30.3 fixture dump for the real-browser width pass", () => {
  it("writes every section's ready-state markup plus the shipped stylesheet", () => {
    mkdirSync(OUT, { recursive: true });
    const sections: Record<string, string> = {};
    for (const name of SECTION_NAMES) sections[name] = sectionHtml(name, "ready");
    expect(Object.keys(sections).length, "all sections dumped").toBe(SECTION_NAMES.length);
    for (const [name, html] of Object.entries(sections)) {
      expect(html.length, `${name} markup must not be empty`).toBeGreaterThan(40);
      expect(html, `${name} must carry its section hook`).toContain(`data-portal-section="${name}"`);
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

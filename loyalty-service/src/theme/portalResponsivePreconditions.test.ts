/**
 * STATIC PRECONDITIONS FOR TASK 30.3 — Requirements 25.5, 25.6, 25.7, 25.8, 17.4.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 * 30.3 measures the portal in a real browser at eight widths and asserts, per
 * section, that `document.documentElement.scrollWidth <= width`. **This file does
 * not do that and cannot.** jsdom has no layout engine, so `scrollWidth` there is
 * meaningless; §26 is explicit that a jsdom result is not evidence for that gate.
 *
 * What it does instead is pin the *declarations* 30.3's criteria name by number —
 * the 1-up/2-up wishlist boundary at 390, the 750 px tablet boundary, and the five
 * bottom-bar targets at 320 — so that a CSS or nav refactor cannot silently move a
 * boundary the expensive manual pass is supposed to be verifying. A failing manual
 * pass costs a device lab session; a failing test here costs nothing.
 *
 * Treat it as a precondition: if these are red, do not book the browser pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const CSS = readFileSync(join(REPO_ROOT, "theme", "assets", "athoor-portal.css"), "utf8");
const NAV = readFileSync(join(REPO_ROOT, "theme", "snippets", "portal-nav.liquid"), "utf8");

/**
 * The declaration bodies of EVERY `@media` matching `query`, concatenated.
 *
 * All of them, not the first: the built stylesheet contains five separate
 * `min-width:750px` blocks, because each section's rules are authored beside that
 * section and the bundler does not merge at-rules. An earlier version of this
 * helper returned only the first match and reported `null` for a rule that is
 * plainly present two blocks later — a false failure that reads exactly like a
 * missing breakpoint.
 */
function mediaBlocks(query: RegExp): string {
  const global = new RegExp(query.source, query.flags.includes("g") ? query.flags : query.flags + "g");
  const bodies: string[] = [];
  for (const match of CSS.matchAll(global)) {
    const open = CSS.indexOf("{", match.index ?? 0);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") {
        depth--;
        if (depth === 0) {
          bodies.push(CSS.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies.join("\n");
}

/** Value of a CSS custom property declared on the portal root. */
function token(name: string): string {
  const m = CSS.match(new RegExp(`--${name}:\\s*([^;}]+)`));
  expect(m, `--${name} must be declared`).not.toBeNull();
  return (m as RegExpMatchArray)[1].trim();
}

describe("30.3 static preconditions: the boundaries the browser pass will measure", () => {
  it("declares the wishlist 1-up/2-up boundary at exactly 390px", () => {
    // §25.6 names 390 specifically. Below it the grid is a single column; at it,
    // two. If this moved to 375 or 414 the manual pass would still "pass" at its
    // own eight widths while testing a different boundary than the spec states.
    const single = CSS.match(
      /\.athoor-wishlist__grid\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(single, "the wishlist grid must be one column by default").not.toBeNull();

    // Asserted the other way round — find the rule, then read the breakpoint that
    // encloses it. "Some 390px block contains the 2-up rule" would be satisfied by
    // an unrelated 390px block elsewhere in the sheet, and there IS one (the
    // profile birthday controls). Pinning the enclosing query is what actually
    // fixes the boundary at 390.
    const twoUp = CSS.indexOf(".athoor-wishlist__grid{grid-template-columns:repeat(2,");
    expect(twoUp, "the wishlist 2-up rule must exist").toBeGreaterThan(-1);
    const enclosing = CSS.lastIndexOf("@media", twoUp);
    expect(enclosing).toBeGreaterThan(-1);
    const query = CSS.slice(enclosing, CSS.indexOf("{", enclosing));
    expect(query, "the wishlist 2-up rule must sit at the 390px boundary").toMatch(
      /min-width:\s*390px/,
    );
  });

  it("steps the wishlist grid at the 750 and 990 boundaries, not elsewhere", () => {
    const columnsAt = (px: number) => {
      const block = mediaBlocks(new RegExp(`@media screen and \\(min-width:\\s*${px}px`));
      const m = block.match(/\.athoor-wishlist__grid\{[^}]*repeat\((\d+),/);
      return m ? Number(m[1]) : null;
    };
    expect(columnsAt(750)).toBe(3);
    expect(columnsAt(990)).toBe(4);
  });

  it("puts exactly four primary entries in the bar, plus one More — five targets", () => {
    // §25.5's "five bottom-nav targets >= 44px at 320". The nav declares eight
    // destinations and promotes the first four; the fifth target is the More
    // control. Changing `<= 4` to `<= 5` would make it six targets, and nothing
    // else in the suite would notice.
    const items = NAV.match(/assign nav_items = '([^']+)'/);
    expect(items, "portal-nav.liquid must declare nav_items").not.toBeNull();
    const entries = (items as RegExpMatchArray)[1].split(",").filter((s) => s.trim() !== "");
    expect(entries.length).toBe(8);

    expect(NAV).toMatch(/forloop\.index\s*<=\s*4/);
    // The overflow entries are the ones NOT promoted, and the More control is the
    // fifth target that reveals them.
    expect(NAV).toContain("athoor-portal__nav-item--overflow");
    expect(NAV).toContain("athoor-portal__nav-item--more");
  });

  it("fits five 44px targets across the narrowest supported width", () => {
    // Arithmetic, not layout: five targets at the declared minimum must at least
    // be able to fit in 320 CSS pixels. 5 x 44 = 220 <= 320. This is what makes
    // the "five targets at 320" requirement satisfiable at all; if either number
    // changed adversely the requirement would become impossible and the manual
    // pass would be chasing a contradiction.
    const target = Number.parseInt(token("athoor-target"), 10);
    expect(target).toBeGreaterThanOrEqual(44);
    expect(5 * target).toBeLessThanOrEqual(320);
  });

  it("makes the bar fixed below 750 and releases it at 750", () => {
    const mobile = mediaBlocks(/@media screen and \(max-width:\s*749px/);
    expect(mobile, "a max-width:749px block must exist").not.toBe("");
    expect(mobile).toMatch(/\.athoor-portal__nav\{[^}]*position:\s*fixed/);
    // Overflow entries are hidden while the bar is fixed, and revealed above it.
    expect(mobile).toMatch(/--overflow\{[^}]*display:\s*none/);

    const tablet = mediaBlocks(/@media screen and \(min-width:\s*750px/);
    expect(tablet, "a min-width:750px block must exist").not.toBe("");
    expect(tablet).toMatch(/--overflow\{[^}]*display:\s*block/);
    expect(tablet).toMatch(/--more\{[^}]*display:\s*none/);
  });

  it("gives the fixed bar a height at least the target minimum", () => {
    // A 44px target inside a shorter bar would be clipped, which is the specific
    // way "no clipped text" and ">= 44px" can both be declared and still fail.
    const bar = Number.parseInt(token("athoor-bar-height"), 10);
    const target = Number.parseInt(token("athoor-target"), 10);
    expect(bar).toBeGreaterThanOrEqual(target);
  });

  it("reserves space so the fixed bar never covers focused content (Req 17.4)", () => {
    // The mobile-keyboard case in 30.3: the submit control must not sit under the
    // fixed bar. The portal reserves scroll padding for exactly this.
    expect(CSS).toMatch(/scroll-padding-block-end:\s*calc\([^)]*--athoor-bar-height/);
    expect(CSS).toMatch(/scroll-margin-block-end:\s*calc\([^)]*--athoor-bar-height/);
  });
});

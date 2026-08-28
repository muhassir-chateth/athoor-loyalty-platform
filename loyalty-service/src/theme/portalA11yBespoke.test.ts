// @vitest-environment jsdom
/**
 * TASK 29.2 — the accessibility assertions axe cannot make.
 * Validates Requirements 17.2, 17.8, 17.10 (design §20.3, §20.4, §20.7, §18.4).
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 * 29.1 runs axe at `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`/`wcag22aa`. Every rule
 * this file replaces was checked against `axe.getRules([...those tags])` and is NOT
 * in it:
 *
 *   heading-order ......... not in the wcag tag set → Gate A below
 *   empty-heading ......... not in the wcag tag set → Gate A below
 *   page-has-heading-one .. not in the wcag tag set → Gate A below
 *   color-contrast ........ in the set, but undecidable in jsdom → Gate B below
 *
 * So 29.2 is not belt-and-braces over 29.1; it is the part of Level AA that a
 * tag-filtered axe run in a layout-free DOM provably cannot decide. Where the two
 * files do overlap (accessible names), 29.2 asserts the *§20.4 shape* — icon-only
 * controls in particular — which axe cannot distinguish from a named one.
 *
 * ── THE ORACLE VS THE SUBJECT ────────────────────────────────────────────────
 * Design §20.7's table is TRANSCRIBED here, because it is the specification and a
 * gate needs a fixed oracle. The token VALUES are READ from
 * `theme-src/portal/styles/base.css` at run time. That split is the whole point: a
 * future token edit changes the subject but not the oracle, so it fails the build
 * rather than silently redefining what "pass" means. Transcribing both would only
 * verify the transcription (task 24's lesson).
 *
 * SAFETY: jsdom and two file reads. No network, no database, no storage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, SECTION_NAMES, STATE_NAMES, sectionHtml } from "./portalFixtures.js";

const BASE_CSS = readFileSync(join(REPO_ROOT, "theme-src", "portal", "styles", "base.css"), "utf8");

/* ══════════════════════════════════════════════════════════════════════════ *
 * Gate A — the heading-outline walk (§20.3, Requirement 17.10)
 * ══════════════════════════════════════════════════════════════════════════ */

interface Heading {
  readonly level: number;
  readonly text: string;
  readonly tag: string;
}

function headings(root: ParentNode): Heading[] {
  return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((el) => ({
    level: Number(el.tagName.slice(1)),
    text: (el.textContent ?? "").trim(),
    tag: el.tagName.toLowerCase(),
  }));
}

/**
 * The walk itself, returned as a list of complaints rather than thrown, so a
 * failure message can name every problem in one run instead of the first.
 */
function outlineFaults(found: readonly Heading[]): string[] {
  const faults: string[] = [];
  const h1s = found.filter((h) => h.level === 1);
  if (h1s.length !== 1) faults.push(`expected exactly one <h1>, found ${String(h1s.length)}`);
  if (found.length > 0 && found[0]?.level !== 1) {
    faults.push(`the first heading is <${found[0]?.tag ?? "?"}>, not <h1>`);
  }
  for (const [index, heading] of found.entries()) {
    if (heading.text === "") faults.push(`<${heading.tag}> at position ${String(index)} has no text`);
    if (index === 0) continue;
    const previous = found[index - 1];
    if (previous === undefined) continue;
    // Descending deeper by more than one level is the defect 17.10 names. Coming
    // back UP any distance is legal — a new <h2> after an <h3> starts a sibling.
    const jump = heading.level - previous.level;
    if (jump > 1) {
      faults.push(
        `level jump of ${String(jump)}: <${previous.tag}> "${previous.text}" → <${heading.tag}> "${heading.text}"`,
      );
    }
  }
  return faults;
}

describe("Task 29.2 Gate A — heading outline (§20.3, Requirement 17.10)", () => {
  for (const section of SECTION_NAMES) {
    for (const state of STATE_NAMES) {
      it(`${section} / ${state} has one h1 and never skips a level`, () => {
        document.body.innerHTML = sectionHtml(section, state);
        const faults = outlineFaults(headings(document.body));
        expect(faults, `heading outline faults in ${section} / ${state}:\n  - ${faults.join("\n  - ")}`).toEqual(
          [],
        );
      });
    }
  }

  it("is NON-VACUOUS: the walk rejects the outlines it exists to reject", () => {
    const walk = (html: string): string[] => {
      document.body.innerHTML = html;
      return outlineFaults(headings(document.body));
    };
    // A jump of exactly two, which is the canonical 17.10 defect.
    expect(walk("<h1>a</h1><h3>b</h3>").join(" ")).toContain("level jump of 2");
    // A jump of three.
    expect(walk("<h1>a</h1><h4>b</h4>").join(" ")).toContain("level jump of 3");
    // Two h1s.
    expect(walk("<h1>a</h1><h1>b</h1>").join(" ")).toContain("expected exactly one <h1>");
    // No h1 at all, and the first heading is not h1.
    expect(walk("<h2>a</h2>").join(" ")).toContain("expected exactly one <h1>");
    expect(walk("<h2>a</h2>").join(" ")).toContain("not <h1>");
    // An empty heading, which announces a nameless landmark in the outline.
    expect(walk("<h1></h1>").join(" ")).toContain("has no text");
    // And the shapes that are LEGAL must not be reported, or the gate is noise.
    expect(walk("<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>")).toEqual([]);
    expect(walk("<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h2>e</h2>")).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * Gate B — the contrast matrix over §20.7's token pairs (Requirement 17.2)
 * ══════════════════════════════════════════════════════════════════════════ */

/** WCAG 2.x relative luminance. sRGB, the 0.03928 threshold, the 2.4 exponent. */
function relativeLuminance(hex: string): number {
  const normalised = hex.replace("#", "");
  const full =
    normalised.length === 3
      ? [...normalised].map((c) => c + c).join("")
      : normalised;
  const channel = (offset: number): number => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG 2.x contrast ratio, always ≥ 1. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Read one custom property's value out of the real stylesheet. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(BASE_CSS);
  if (match?.[1] === undefined) {
    throw new Error(`token --${name} is not declared in theme-src/portal/styles/base.css`);
  }
  return match[1].toLowerCase();
}

/**
 * Design §20.7, transcribed — with one correction recorded rather than hidden.
 *
 * `fgExpected`/`bgExpected` are the hexes §20.7 computed against; the test asserts
 * the CSS still declares them, so a token change fails here.
 *
 * `threshold` is the ratio the pair must meet. `decorative` rows are the ones the
 * design deliberately restricts to non-text use; they are asserted to be BELOW the
 * text threshold (which is *why* they are restricted) and forbidden as a text colour
 * in the stylesheet, rather than asserted to pass.
 *
 * ── WHY THERE ARE TWO RATIO FIELDS ──────────────────────────────────────────
 * `designSays` is §20.7's published figure. `measured` is what the WCAG formula
 * actually returns for those hexes, computed here and pinned to two decimal places.
 *
 * They disagree on five rows, by up to 1.50. The formula in this file was checked
 * against values the standard fixes — black on white is exactly 21:1, `#767676` on
 * white is the canonical boundary that just passes 4.5:1, `#777777` just fails — so
 * `measured` is the correct column and §20.7's figures are approximations, one of
 * them materially off (ink on white is 17.40:1, not 18.9:1).
 *
 * **Every verdict in §20.7 is nevertheless correct**: each pair that must reach
 * 4.5:1 does, and each decorative pair is genuinely below it. So this is a
 * documentation imprecision in the design, not a contrast defect in the portal, and
 * the gate pins the computed column because that is the one a token change moves.
 * `theContrastFiguresDisagreeWithTheDesign` below asserts the disagreement set so it
 * stays visible instead of becoming folklore.
 */
interface Pair {
  readonly label: string;
  readonly fgToken: string | null;
  readonly fgExpected: string;
  readonly bgToken: string | null;
  readonly bgExpected: string;
  readonly designSays: number;
  readonly measured: number;
  readonly threshold: number;
  readonly decorative: boolean;
  readonly exempt?: string;
}

const CONTRAST_MATRIX: readonly Pair[] = [
  {
    label: "ink on white",
    fgToken: "athoor-ink",
    fgExpected: "#1a1a1a",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 18.9,
    measured: 17.40,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "ink on surface",
    fgToken: "athoor-ink",
    fgExpected: "#1a1a1a",
    bgToken: "athoor-surface",
    bgExpected: "#fafafa",
    designSays: 17.9,
    measured: 16.67,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "muted on white",
    fgToken: "athoor-muted-text",
    fgExpected: "#6f665d",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 5.5,
    measured: 5.62,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "muted on surface",
    fgToken: "athoor-muted-text",
    fgExpected: "#6f665d",
    bgToken: "athoor-surface",
    bgExpected: "#fafafa",
    designSays: 5.2,
    measured: 5.39,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "gold text on white",
    fgToken: "athoor-gold-text",
    fgExpected: "#8c6b00",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 4.9,
    measured: 4.98,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "gold text on surface (narrow — do not darken the surface further)",
    fgToken: "athoor-gold-text",
    fgExpected: "#8c6b00",
    bgToken: "athoor-surface",
    bgExpected: "#fafafa",
    designSays: 4.6,
    measured: 4.77,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "white on ink (primary button)",
    fgToken: null,
    fgExpected: "#ffffff",
    bgToken: "athoor-ink",
    bgExpected: "#1a1a1a",
    designSays: 18.9,
    measured: 17.40,
    threshold: 4.5,
    decorative: false,
  },
  {
    label: "hairline on white — decorative only, never the sole control boundary",
    fgToken: "athoor-line",
    fgExpected: "#f0ede8",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 1.1,
    measured: 1.17,
    threshold: 3,
    decorative: true,
  },
  {
    label: "gold on white — decorative only, forbidden as text (§18.4)",
    fgToken: "athoor-gold",
    fgExpected: "#b8960c",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 3.0,
    measured: 2.84,
    threshold: 4.5,
    decorative: true,
  },
  {
    label: "disabled on white",
    fgToken: "athoor-disabled",
    fgExpected: "#8a8580",
    bgToken: null,
    bgExpected: "#ffffff",
    designSays: 3.5,
    measured: 3.65,
    threshold: 4.5,
    decorative: true,
    exempt: "disabled text is exempt, and the state is stated in text as well (§18.4)",
  },
];

/** The three tokens §18.4 forbids as a text colour, with the reason. */
const FORBIDDEN_AS_TEXT: readonly { readonly token: string; readonly why: string }[] = [
  { token: "athoor-gold", why: "3.0:1 on white — fails 4.5:1 for text (§18.4)" },
  { token: "athoor-line", why: "1.1:1 on white — a hairline, never a text colour (§18.4)" },
  { token: "athoor-disabled", why: "3.5:1 on white — a background token, never text (§18.4)" },
];

describe("Task 29.2 Gate B — contrast matrix over §20.7 (Requirement 17.2)", () => {
  it("computes WCAG ratios correctly, checked against values fixed by the standard", () => {
    // Without this the whole matrix could pass on a broken formula.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    // Symmetry: the ratio does not depend on argument order.
    expect(contrastRatio("#1a1a1a", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#1a1a1a"), 10);
    // A mid grey, from the WCAG reference: #767676 on white is the canonical 4.54:1.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  for (const pair of CONTRAST_MATRIX) {
    it(`${pair.label}: the stylesheet still declares the tokens §20.7 computed`, () => {
      if (pair.fgToken !== null) expect(token(pair.fgToken), `--${pair.fgToken} changed`).toBe(pair.fgExpected);
      if (pair.bgToken !== null) expect(token(pair.bgToken), `--${pair.bgToken} changed`).toBe(pair.bgExpected);
    });

    it(`${pair.label}: measures exactly ${pair.measured.toFixed(2)}:1`, () => {
      const foreground = pair.fgToken === null ? pair.fgExpected : token(pair.fgToken);
      const background = pair.bgToken === null ? pair.bgExpected : token(pair.bgToken);
      const measured = contrastRatio(foreground, background);
      // ±0.01. The value is pinned rather than bounded, so ANY token change moves it
      // and fails — including one that happens to stay the right side of a threshold.
      expect(measured, `${foreground} on ${background} measured ${measured.toFixed(4)}:1`).toBeCloseTo(
        pair.measured,
        2,
      );
    });

    if (pair.decorative) {
      it(`${pair.label}: is genuinely below 4.5:1, which is WHY it is restricted`, () => {
        // Asserting this rather than skipping the row turns "decorative" from a label
        // into a claim. If a future token change made one of these pass as text, the
        // §18.4 prohibition would be over-restrictive and this test says so.
        const foreground = pair.fgToken === null ? pair.fgExpected : token(pair.fgToken);
        const background = pair.bgToken === null ? pair.bgExpected : token(pair.bgToken);
        expect(contrastRatio(foreground, background)).toBeLessThan(4.5);
      });
    } else {
      it(`${pair.label}: meets ${String(pair.threshold)}:1`, () => {
        const foreground = pair.fgToken === null ? pair.fgExpected : token(pair.fgToken);
        const background = pair.bgToken === null ? pair.bgExpected : token(pair.bgToken);
        const measured = contrastRatio(foreground, background);
        expect(
          measured,
          `${pair.label}: ${measured.toFixed(2)}:1 is below the required ${String(pair.threshold)}:1`,
        ).toBeGreaterThanOrEqual(pair.threshold);
      });
    }
  }

  it("records where §20.7's published figures disagree with the computed ratio", () => {
    // Kept as an assertion so the discrepancy is part of the suite rather than a note
    // someone once made. If §20.7 is corrected, this test fails and is updated with
    // the design — which is the right coupling.
    const disagreements = CONTRAST_MATRIX.filter(
      (pair) => Math.abs(pair.designSays - pair.measured) > 0.1,
    ).map((pair) => `${pair.label}: §20.7 says ${pair.designSays.toFixed(1)}, computed ${pair.measured.toFixed(2)}`);
    expect(disagreements.sort()).toEqual([
      "disabled on white: §20.7 says 3.5, computed 3.65",
      "gold on white — decorative only, forbidden as text (§18.4): §20.7 says 3.0, computed 2.84",
      "gold text on surface (narrow — do not darken the surface further): §20.7 says 4.6, computed 4.77",
      "ink on surface: §20.7 says 17.9, computed 16.67",
      "ink on white: §20.7 says 18.9, computed 17.40",
      "muted on surface: §20.7 says 5.2, computed 5.39",
      "muted on white: §20.7 says 5.5, computed 5.62",
      "white on ink (primary button): §20.7 says 18.9, computed 17.40",
    ]);
    // The figures differ; every VERDICT still holds. That is the claim that matters,
    // and it is asserted independently of the figures above.
    for (const pair of CONTRAST_MATRIX) {
      const foreground = pair.fgToken === null ? pair.fgExpected : token(pair.fgToken);
      const background = pair.bgToken === null ? pair.bgExpected : token(pair.bgToken);
      const measured = contrastRatio(foreground, background);
      if (pair.decorative) {
        expect(measured, `${pair.label} should be below 4.5:1`).toBeLessThan(4.5);
      } else {
        expect(measured, `${pair.label} should meet ${String(pair.threshold)}:1`).toBeGreaterThanOrEqual(
          pair.threshold,
        );
      }
    }
  });

  it("the two rows that fail as text are exactly the two §18.4 restricts to decoration", () => {
    // Stated as an equality so a future row cannot be quietly marked decorative to
    // dodge the threshold. `athoor-disabled` carries an explicit exemption reason.
    const decorative = CONTRAST_MATRIX.filter((p) => p.decorative && p.exempt === undefined).map(
      (p) => p.fgToken,
    );
    expect(decorative.sort()).toEqual(["athoor-gold", "athoor-line"]);
    const exempt = CONTRAST_MATRIX.filter((p) => p.exempt !== undefined);
    expect(exempt).toHaveLength(1);
    expect(exempt[0]?.fgToken).toBe("athoor-disabled");
    expect(exempt[0]?.exempt).toContain("stated in text");
  });

  for (const forbidden of FORBIDDEN_AS_TEXT) {
    it(`--${forbidden.token} is never used as a text colour: ${forbidden.why}`, () => {
      // `color:` and its longhand friends, by token reference and by literal, so
      // inlining the hex is not a way around the rule.
      const literal = token(forbidden.token);
      const patterns = [
        new RegExp(`(?:^|[^-\\w])color:\\s*var\\(\\s*--${forbidden.token}\\s*[),]`, "gi"),
        new RegExp(`(?:^|[^-\\w])color:\\s*${literal}\\b`, "gi"),
        new RegExp(`-webkit-text-fill-color:\\s*var\\(\\s*--${forbidden.token}\\s*[),]`, "gi"),
      ];
      for (const pattern of patterns) {
        const hits = BASE_CSS.match(pattern) ?? [];
        expect(hits, `${forbidden.token} used as text: ${hits.join(", ")}`).toEqual([]);
      }
    });
  }

  it("is NON-VACUOUS: the forbidden-as-text scan finds the declaration it forbids", () => {
    // Proves the regexes match a real declaration rather than being unsatisfiable.
    const gold = token("athoor-gold");
    const probe = `.x { color: var(--athoor-gold); } .y { color: ${gold}; }`;
    expect(probe).toMatch(/(?:^|[^-\w])color:\s*var\(\s*--athoor-gold\s*[),]/i);
    expect(probe).toMatch(new RegExp(`(?:^|[^-\\w])color:\\s*${gold}\\b`, "i"));
    // And that the permitted `--athoor-gold-text` is NOT caught by the gold pattern,
    // or the gate would forbid the very token §18.4 provides for text.
    const permitted = `.z { color: var(--athoor-gold-text); }`;
    expect(permitted).not.toMatch(/(?:^|[^-\w])color:\s*var\(\s*--athoor-gold\s*[),]/i);
    // The stylesheet really does use the text token, so the split is in force.
    expect(BASE_CSS).toMatch(/color:\s*var\(\s*--athoor-gold-text\s*\)/);
  });

  it("is NON-VACUOUS: a changed token would be caught", () => {
    // The subject is read from the file, so simulate the read returning a darker
    // surface — §20.7's stated hazard — and confirm the narrow pair then fails.
    const goldText = token("athoor-gold-text");
    expect(contrastRatio(goldText, "#fafafa")).toBeGreaterThanOrEqual(4.5);
    // "do not darken the surface further" is a real constraint, not a note:
    expect(contrastRatio(goldText, "#f2f2f2")).toBeLessThan(4.5);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * Gate C — accessible names, and the icon-only rule (§20.4)
 * ══════════════════════════════════════════════════════════════════════════ */

const CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
].join(",");

/**
 * Escape a value for use inside a double-quoted attribute selector.
 *
 * `CSS.escape` is not implemented by the jsdom build this suite runs on, and an
 * unescaped id would throw on any value containing a quote or backslash. Quoted
 * attribute selectors need only those two characters escaped, so this is the whole
 * requirement rather than a partial re-implementation of `CSS.escape`.
 */
function cssQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Text content with `aria-hidden` subtrees removed, which is what AT reads. */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A deliberately conservative accessible-name approximation. */
function accessibleName(el: Element, root: ParentNode): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy.trim() !== "") {
    const parts = labelledBy
      .split(/\s+/)
      // `[id="…"]` rather than `#…`, so an id needing escaping resolves rather than
      // throwing — the same reason `cssQuote` exists.
      .map((id) => root.querySelector(`[id="${cssQuote(id)}"]`))
      .filter((node): node is Element => node !== null)
      .map((node) => visibleText(node));
    if (parts.join(" ").trim() !== "") return parts.join(" ").trim();
  }
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  const text = visibleText(el);
  if (text !== "") return text;
  const title = el.getAttribute("title");
  if (title !== null && title.trim() !== "") return title.trim();
  if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) {
    if (el.value.trim() !== "") return el.value.trim();
  }
  // A `<label>` names `<input>`, `<select>` AND `<textarea>` alike. Restricting this
  // lookup to `HTMLInputElement` reported the portal's labelled `<select>`s as
  // nameless — a false positive, and axe's `select-name` rule (which IS in the wcag
  // tag set) had already passed them.
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.id !== "") {
      const explicit = root.querySelector(`label[for="${cssQuote(el.id)}"]`);
      if (explicit !== null && visibleText(explicit) !== "") return visibleText(explicit);
    }
    const wrapping = el.closest("label");
    if (wrapping !== null && visibleText(wrapping) !== "") return visibleText(wrapping);
  }
  const image = el.querySelector("img[alt]");
  if (image !== null) {
    const alt = image.getAttribute("alt");
    if (alt !== null && alt.trim() !== "") return alt.trim();
  }
  return "";
}

/** Does this control's rendered content consist only of an icon? */
function isIconOnly(el: Element): boolean {
  if (visibleText(el) !== "") return false;
  const iconish = el.querySelectorAll('svg,img,i,[aria-hidden="true"],use,[class*="icon"]');
  return iconish.length > 0;
}

function describeControl(el: Element): string {
  return el.outerHTML.replace(/\s+/g, " ").slice(0, 140);
}

/**
 * The one control in the portal that is deliberately nameless at server render.
 *
 * `[hidden]` removes an element from the accessibility tree, so a hidden control
 * cannot present a barrier — but "it is hidden" is only a valid excuse if it is
 * still nameless when it becomes visible. 15 of the portal's 16 hidden controls
 * carry server-rendered text anyway. This one cannot: its label contains the
 * carrier's tracking number, which is not known until the fetch returns.
 *
 * So the exemption is granted HERE, by name, and paid for by
 * `the one nameless hidden control is named before it is ever revealed` below, which
 * asserts the ordering in the module that makes it safe. Reversing those two lines
 * fails that test. This is deliberately a list of one: a second entry is a reviewed
 * change, not a way to quiet the gate.
 */
const NAMED_ONLY_AFTER_FETCH: readonly string[] = ["data-portal-tracking"];

function isExemptFromServerRenderName(el: Element): boolean {
  return el.hasAttribute("hidden") && NAMED_ONLY_AFTER_FETCH.some((hook) => el.hasAttribute(hook));
}

describe("Task 29.2 Gate C — accessible names and the icon-only rule (§20.4)", () => {
  for (const section of SECTION_NAMES) {
    for (const state of STATE_NAMES) {
      it(`${section} / ${state}: every control has a non-empty accessible name`, () => {
        document.body.innerHTML = sectionHtml(section, state);
        const unnamed = [...document.body.querySelectorAll(CONTROL_SELECTOR)]
          .filter((el) => !isExemptFromServerRenderName(el))
          .filter((el) => accessibleName(el, document.body) === "")
          .map((el) => describeControl(el));
        expect(unnamed, `controls with no accessible name in ${section} / ${state}:\n  ${unnamed.join("\n  ")}`).toEqual(
          [],
        );
      });
    }
  }

  it("hidden controls are named at server render too, with exactly one listed exception", () => {
    // The point of this test is that the exemption list cannot grow silently. A new
    // hidden-and-nameless control fails here even though `[hidden]` keeps it out of
    // the accessibility tree, because it will not stay hidden.
    const namelessHidden = new Set<string>();
    for (const section of SECTION_NAMES) {
      document.body.innerHTML = sectionHtml(section, "ready");
      for (const el of document.body.querySelectorAll(CONTROL_SELECTOR)) {
        if (!el.hasAttribute("hidden")) continue;
        if (accessibleName(el, document.body) !== "") continue;
        namelessHidden.add(describeControl(el));
      }
    }
    expect([...namelessHidden]).toHaveLength(1);
    expect([...namelessHidden][0]).toContain("data-portal-tracking");
    expect(NAMED_ONLY_AFTER_FETCH).toHaveLength(1);
  });

  it("the one nameless hidden control is named BEFORE it is ever revealed", () => {
    // This is what buys the exemption above. The tracking anchor's label contains the
    // carrier's tracking number, so it cannot be server-rendered — but the module must
    // therefore set the text before dropping `hidden`, or the anchor enters the
    // accessibility tree with no discernible name. Asserted on source ORDER, because
    // the two statements in the other order compile, pass every other test, and ship
    // the defect. Swapping lines 306 and 307 of `orderDetail.ts` fails here.
    const source = readFileSync(
      join(REPO_ROOT, "theme-src", "portal", "sections", "orderDetail.ts"),
      "utf8",
    );
    const namePosition = source.indexOf("tracking.textContent");
    const revealPosition = source.indexOf('tracking.removeAttribute("hidden")');
    expect(namePosition, "orderDetail.ts no longer sets tracking.textContent").toBeGreaterThan(-1);
    expect(revealPosition, "orderDetail.ts no longer reveals the tracking anchor").toBeGreaterThan(-1);
    expect(
      namePosition,
      "the tracking anchor is revealed BEFORE it is named — it would enter the a11y tree nameless",
    ).toBeLessThan(revealPosition);
    // And the no-tracking case removes the anchor rather than leaving an empty one.
    expect(source).toMatch(/tracking\.remove\(\)/);
  });

  it("a digital-only order removes the whole delivery block, not just its paragraph", () => {
    // The heading-outline counterpart of the test above, and a defect this gate found.
    //
    // `order-detail` renders `<section><h3>Delivered to</h3><p data-portal-address>`.
    // The module used to call `addressNode.remove()`, which removes the PARAGRAPH and
    // leaves the `<h3>` standing over nothing on every order with no shipping address.
    // A heading that promises content which is not there is a false structural claim,
    // and no fixture can see it because it only happens after the module runs — so it
    // is asserted here against the source, on the same principle as the ordering test
    // above. Reverting to `addressNode.remove()` fails this.
    const source = readFileSync(
      join(REPO_ROOT, "theme-src", "portal", "sections", "orderDetail.ts"),
      "utf8",
    );
    expect(source).toMatch(/addressNode\.closest\(\s*"\[data-portal-address-block\]"\s*\)/);
    // The bare narrower removal must not be what runs. `closest(...) ?? addressNode`
    // still mentions `addressNode`, so the check is for the STATEMENT, not the name.
    expect(source).not.toMatch(/(?:^|[^.\w])addressNode\.remove\(\)/m);

    // And the template must still carry the handle the module reaches for, or the
    // `?? addressNode` fallback would silently restore the old, defective behaviour.
    const liquid = readFileSync(join(REPO_ROOT, "theme", "snippets", "portal-section.liquid"), "utf8");
    expect(liquid).toMatch(/data-portal-address-block/);
    // The handle must be on the element that CONTAINS the heading.
    const block = /<section[^>]*data-portal-address-block[^>]*>([\s\S]*?)<\/section>/.exec(liquid);
    expect(block, "data-portal-address-block is not on a <section>").not.toBeNull();
    expect(block?.[1]).toMatch(/<h3[^>]*>\s*Delivered to\s*<\/h3>/);
    expect(block?.[1]).toMatch(/data-portal-address/);
  });

  it("every icon-only control carries a non-empty accessible name (§20.4)", () => {
    // The portal currently ships NO icon-only control — every one carries visible
    // text. That is asserted below as a fact rather than assumed, and this loop is
    // what keeps it true if an icon is ever introduced: an icon-only control with
    // no `aria-label`/`aria-labelledby`/visually-hidden text fails here.
    const offenders: string[] = [];
    let iconOnlyCount = 0;
    for (const section of SECTION_NAMES) {
      for (const state of STATE_NAMES) {
        document.body.innerHTML = sectionHtml(section, state);
        for (const el of document.body.querySelectorAll(CONTROL_SELECTOR)) {
          if (!isIconOnly(el)) continue;
          iconOnlyCount += 1;
          if (accessibleName(el, document.body) === "") {
            offenders.push(`${section}/${state}: ${describeControl(el)}`);
          }
        }
      }
    }
    expect(offenders, `icon-only controls with no accessible name:\n  ${offenders.join("\n  ")}`).toEqual([]);
    // Recorded so the number is visible rather than implied. If this becomes
    // non-zero the loop above starts doing work, which is the intent.
    expect(iconOnlyCount).toBe(0);
  });

  it("the portal ships no icon markup at all, in Liquid or in source", () => {
    // The structural reason the count above is zero. Asserted over the real files so
    // it cannot drift silently — and if it does, the loop above already covers it.
    const liquid = readFileSync(join(REPO_ROOT, "theme", "snippets", "portal-section.liquid"), "utf8");
    expect(liquid).not.toMatch(/<svg[\s>]/i);
    expect(liquid).not.toMatch(/<use[\s>]/i);
  });

  it("is NON-VACUOUS: the name and icon-only checks reject what they exist to reject", () => {
    const check = (html: string): { unnamed: number; iconOnly: number } => {
      document.body.innerHTML = html;
      const controls = [...document.body.querySelectorAll(CONTROL_SELECTOR)];
      return {
        unnamed: controls.filter((el) => accessibleName(el, document.body) === "").length,
        iconOnly: controls.filter((el) => isIconOnly(el)).length,
      };
    };
    // An icon-only button with no name: detected as both icon-only and unnamed.
    const bare = check(`<button type="button"><svg aria-hidden="true"></svg></button>`);
    expect(bare.iconOnly).toBe(1);
    expect(bare.unnamed).toBe(1);
    // The same button with an aria-label: still icon-only, but now named.
    const labelled = check(`<button type="button" aria-label="Copy your referral link"><svg aria-hidden="true"></svg></button>`);
    expect(labelled.iconOnly).toBe(1);
    expect(labelled.unnamed).toBe(0);
    // And with visually-hidden text instead, which is what §20.4 specifies.
    const hiddenText = check(
      `<button type="button"><svg aria-hidden="true"></svg><span class="athoor-portal__visually-hidden">Copy your referral link</span></button>`,
    );
    expect(hiddenText.iconOnly).toBe(0);
    expect(hiddenText.unnamed).toBe(0);
    // An unlabelled input is unnamed; a labelled one is not.
    expect(check(`<input type="text" id="a">`).unnamed).toBe(1);
    expect(check(`<label for="a">Your name</label><input type="text" id="a">`).unnamed).toBe(0);
    // aria-hidden text does not count as a name.
    expect(check(`<button type="button"><span aria-hidden="true">x</span></button>`).unnamed).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * Gate D — no state distinction by colour alone (Requirement 17.8, §18.4)
 * ══════════════════════════════════════════════════════════════════════════ */

interface Rule {
  readonly selector: string;
  readonly block: string;
  /** The enclosing at-rule condition, or `null` when the rule is unconditional. */
  readonly media: string | null;
}

/**
 * Parse the stylesheet into rules, tracking whether each is inside an at-rule.
 *
 * The distinction matters more than it looks. A declaration inside
 * `@media (forced-colors: active)` applies only there; a declaration outside every
 * at-rule applies ALWAYS — including inside the media queries, because that is what
 * the cascade does. So "is this state conveyed by something other than colour" is a
 * question about the unconditional rule, not about each block in isolation.
 *
 * A naive per-block check gets this wrong in a way that matters: the portal's
 * `@media (forced-colors: active)` rule for the current page sets ONLY
 * `border-inline-start-color`, which is a colour. Read alone it looks like a
 * colour-only state. Read in the cascade it is a *repair* of a decorative border
 * layered on a base rule that already carries `font-weight: 600` — and the weight is
 * not something forced colours removes. Flagging it would be a false positive, and a
 * gate that cries wolf gets disabled.
 */
function cssRules(): Rule[] {
  const rules: Rule[] = [];
  const stack: string[] = [];
  // Comments MUST go first. This stylesheet documents almost every rule, so a
  // comment sits immediately before most `@media` — and with the comment still in the
  // buffer the `@` is no longer the first character, the at-rule is misread as a
  // selector, and its entire body is swallowed as one declaration block. That is how
  // the first draft of this parser found two `[aria-current="page"]` rules instead of
  // five and zero forced-colours rules instead of one.
  const source = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  let index = 0;
  let pending = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "{") {
      const head = pending.replace(/\s+/g, " ").trim();
      pending = "";
      if (head.startsWith("@")) {
        // An at-rule that contains further rules (`@media`, `@supports`).
        stack.push(head);
        index += 1;
        continue;
      }
      // A style rule: consume to its matching close brace.
      let depth = 1;
      let body = "";
      index += 1;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === "{") depth += 1;
        else if (inner === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += inner;
        index += 1;
      }
      index += 1;
      rules.push({ selector: head, block: body, media: stack.length > 0 ? stack.join(" / ") : null });
      continue;
    }
    if (char === "}") {
      stack.pop();
      pending = "";
      index += 1;
      continue;
    }
    pending += char;
    index += 1;
  }
  return rules;
}

const CSS_RULES: readonly Rule[] = cssRules();

/** Rules whose selector mentions the given fragment. */
function rulesMatching(selectorFragment: string): readonly Rule[] {
  return CSS_RULES.filter((rule) => rule.selector.includes(selectorFragment));
}

/** Declaration blocks for a fragment, as before, for the simple assertions. */
function ruleBlocks(selectorFragment: string): string[] {
  return rulesMatching(selectorFragment).map((rule) => rule.block);
}

/** Properties that convey a distinction without using hue. */
const NON_COLOUR_SIGNALS = [
  "font-weight",
  "text-decoration",
  "text-decoration-line",
  "border-inline-start",
  "border-bottom",
  "box-shadow",
  "cursor",
  "outline",
  "content",
  "display",
  "padding",
];

function carriesNonColourSignal(block: string): boolean {
  return NON_COLOUR_SIGNALS.some((property) => new RegExp(`(?:^|[;{\\s])${property}\\s*:`).test(block));
}

describe("Task 29.2 Gate D — no state conveyed by colour alone (Requirement 17.8)", () => {
  it("the current-page state carries a non-colour signal UNCONDITIONALLY", () => {
    const all = rulesMatching('[aria-current="page"]');
    expect(all.length, "no [aria-current=page] rule found at all").toBeGreaterThanOrEqual(3);

    // The assertion that actually protects Requirement 17.8: at least one rule for
    // this state sits outside every at-rule and carries a non-colour property. That
    // declaration applies at every breakpoint and in forced colours, so the state can
    // never reduce to hue alone. Deleting `font-weight: 600` fails this.
    const unconditional = all.filter((rule) => rule.media === null);
    expect(unconditional.length, "[aria-current=page] is only ever styled inside a media query").toBeGreaterThan(
      0,
    );
    const unconditionalSignals = unconditional.filter((rule) => carriesNonColourSignal(rule.block));
    expect(
      unconditionalSignals.length,
      `the current-page state has no unconditional non-colour signal; blocks were:\n${unconditional
        .map((r) => r.block)
        .join("\n---\n")}`,
    ).toBeGreaterThan(0);
    expect(unconditionalSignals.map((r) => r.block).join("\n")).toMatch(/font-weight:\s*600/);

    // The three breakpoint signals §17.4 names, each ADDITIONAL to the weight above:
    // heavier weight on the mobile bar, an inset rule on the tablet row, a leading
    // border on the desktop rail.
    const everything = all.map((r) => r.block).join("\n");
    expect(everything).toMatch(/box-shadow:\s*inset/);
    expect(everything).toMatch(/border-inline-start-color/);

    // Any rule for this state that is colour-only must be inside an at-rule, where the
    // unconditional weight above still applies. A colour-only rule OUTSIDE every
    // at-rule would mean a breakpoint where hue is the only difference.
    const colourOnlyUnconditional = unconditional.filter((rule) => !carriesNonColourSignal(rule.block));
    expect(
      colourOnlyUnconditional.map((r) => `${r.selector} { ${r.block.trim()} }`),
      "an unconditional [aria-current=page] rule distinguishes the state by colour alone",
    ).toEqual([]);
  });

  it("the forced-colours repair is a repair, not the sole signal", () => {
    // Recorded explicitly because this is the rule a naive per-block check would flag.
    // It sets only `border-inline-start-color`, which IS a colour — and that is
    // correct, because it exists to make a decorative gold border visible once tokens
    // are discarded. The state's own signal is the unconditional weight asserted
    // above, which forced colours does not remove.
    const forced = rulesMatching('[aria-current="page"]').filter(
      (rule) => rule.media !== null && rule.media.includes("forced-colors"),
    );
    expect(forced).toHaveLength(1);
    expect(forced[0]?.block).toMatch(/border-inline-start-color:\s*CanvasText/);
    // It changes a colour and nothing else — if it grew a layout property, the
    // comment above would no longer describe it.
    expect(carriesNonColourSignal(forced[0]?.block ?? "")).toBe(false);
  });

  it("the disabled state carries a non-colour signal, not just a muted hue", () => {
    const blocks = ruleBlocks(":disabled");
    expect(blocks.length).toBeGreaterThan(0);
    const withoutSignal = blocks.filter((block) => !carriesNonColourSignal(block));
    expect(withoutSignal, `:disabled distinguished by colour alone:\n${withoutSignal.join("\n---\n")}`).toEqual(
      [],
    );
    expect(blocks.join("\n")).toMatch(/cursor:\s*not-allowed/);
  });

  it("every one of the eight designed states renders a text message, not a colour", () => {
    // The primary non-colour carrier for §18.8's states: each non-ready state shows
    // `.athoor-portal__state-message`, which is prose. Asserted over the fixtures so
    // the element is really present in the state, not just styled for it.
    for (const state of STATE_NAMES) {
      for (const section of SECTION_NAMES) {
        document.body.innerHTML = sectionHtml(section, state);
        const message = document.querySelector("[data-portal-state-message]");
        expect(message, `${section}/${state} has no state message element`).not.toBeNull();
        expect(
          (message?.textContent ?? "").trim(),
          `${section}/${state} state message is empty`,
        ).not.toBe("");
      }
    }
  });

  it("no semantic red or green is introduced (§18.4)", () => {
    // Two new hues would each need their own contrast audit, and a luxury account
    // page that flashes red is a form. The design forbids both outright.
    const declared = [...BASE_CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    for (const hex of declared) {
      const normalised = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
      const r = Number.parseInt(normalised.slice(1, 3), 16);
      const g = Number.parseInt(normalised.slice(3, 5), 16);
      const b = Number.parseInt(normalised.slice(5, 7), 16);
      // A saturated red or green: one channel dominating the other two decisively.
      const dominantRed = r > 120 && r - g > 70 && r - b > 70;
      const dominantGreen = g > 120 && g - r > 70 && g - b > 70;
      expect(dominantRed, `${hex} reads as a semantic red`).toBe(false);
      expect(dominantGreen, `${hex} reads as a semantic green`).toBe(false);
    }
  });

  it("a forced-colours block exists, so the non-colour signals survive token loss", () => {
    // In forced-colours mode every token is discarded. If a state were conveyed by
    // colour alone it would become invisible exactly there, which is why §20.7 keeps
    // this block and why it is asserted rather than assumed.
    expect(BASE_CSS).toMatch(/@media\s*\(\s*forced-colors:\s*active\s*\)/);
    expect(BASE_CSS).toMatch(/CanvasText/);
  });

  it("is NON-VACUOUS: the non-colour-signal check rejects a colour-only block", () => {
    expect(carriesNonColourSignal("color: var(--athoor-ink);")).toBe(false);
    expect(carriesNonColourSignal("background: #fff; color: red;")).toBe(false);
    expect(carriesNonColourSignal("color: var(--athoor-ink); font-weight: 600;")).toBe(true);
    expect(carriesNonColourSignal("cursor: not-allowed;")).toBe(true);
    expect(carriesNonColourSignal("box-shadow: inset 0 -2px 0 0 red;")).toBe(true);
    // `border-inline-start-color` alone is a COLOUR, so it must not count as a
    // signal by itself — the base rule's `font-weight` is what carries that state.
    expect(carriesNonColourSignal("border-inline-start-color: CanvasText;")).toBe(false);
    // And the red/green detector must actually fire on a real red and green.
    const isRed = (hex: string): boolean => {
      const r = Number.parseInt(hex.slice(1, 3), 16);
      const g = Number.parseInt(hex.slice(3, 5), 16);
      const b = Number.parseInt(hex.slice(5, 7), 16);
      return r > 120 && r - g > 70 && r - b > 70;
    };
    expect(isRed("#d32f2f")).toBe(true);
    expect(isRed("#1a1a1a")).toBe(false);
    expect(isRed("#b8960c")).toBe(false);
  });
});

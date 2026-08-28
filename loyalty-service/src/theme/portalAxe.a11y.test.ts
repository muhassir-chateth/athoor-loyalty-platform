// @vitest-environment jsdom
/**
 * TASK 29.1 — the `axe-core` accessibility gate. Validates Requirements 17.1, 17.11.
 *
 * Every Portal_Section fixture, in all eight states of §18.8, against the
 * `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags. **Any violation at
 * those levels fails the build**, which is what makes this a gate rather than a
 * report: it runs inside `npm test`, which `portal-ci.yml` invokes as its own
 * non-conditional step with no `continue-on-error`.
 *
 * ── WHAT AXE CAN AND CANNOT SEE, STATED HONESTLY ────────────────────────────
 * axe in jsdom evaluates the DOM and the ARIA graph. It does NOT evaluate the
 * cascade, because jsdom implements no layout and loads no stylesheet — so
 * `color-contrast` is disabled here and asserted separately in 29.2 against §20.7's
 * token pairs, where the values are knowable without a renderer. Claiming a contrast
 * pass from axe in jsdom would be claiming a result the environment cannot produce.
 *
 * The rules axe CAN decide here are the ones that matter most for this surface:
 * accessible names, roles, `aria-*` validity, label association, heading presence,
 * list structure, duplicate ids, nested-interactive, and region/landmark structure.
 *
 * ── WHY THE FIXTURES ARE EXTRACTED FROM THE SHIPPED LIQUID ──────────────────
 * `portalFixtures.ts` reads `portal-section.liquid` at run time. A gate over a
 * transcription verifies the transcription; task 24 proved that the hard way.
 *
 * SAFETY: jsdom only. No network, no database, no storage.
 */
import { describe, expect, it } from "vitest";
import axe from "axe-core";
import { SECTION_NAMES, STATE_NAMES, sectionHtml } from "./portalFixtures.js";

/** The five conformance tags task 29.1 names. */
const TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Rules disabled with a stated reason, which is the only acceptable way to disable
 * one. Each is disabled because jsdom cannot decide it, never because it was
 * inconvenient.
 */
const UNDECIDABLE_IN_JSDOM: readonly string[] = [
  // Needs the cascade and a layout box. Asserted in 29.2 over §20.7's token pairs.
  "color-contrast",
  // Needs a viewport and computed layout to know what is off-screen.
  "target-size",
];

interface Violation {
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly nodes: number;
  readonly first: string;
}

async function violationsFor(html: string): Promise<Violation[]> {
  document.body.innerHTML = html;
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: [...TAGS] },
    rules: Object.fromEntries(UNDECIDABLE_IN_JSDOM.map((id) => [id, { enabled: false }])),
    // `resultTypes` keeps the payload small; only violations are read.
    resultTypes: ["violations"],
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.length,
    first: violation.nodes[0]?.html?.slice(0, 160) ?? "",
  }));
}

function describeViolations(where: string, found: readonly Violation[]): string {
  return [
    `${String(found.length)} axe violation(s) in ${where}:`,
    ...found.map(
      (v) => `  - [${v.impact ?? "unknown"}] ${v.id}: ${v.help} (${String(v.nodes)} node(s))\n      ${v.first}`,
    ),
  ].join("\n");
}

describe("Task 29.1 — the axe-core accessibility gate", () => {
  it("runs against the real axe-core, at the five WCAG tags 29.1 names", () => {
    // A gate that silently stopped running is the failure mode this catches.
    expect(typeof axe.run).toBe("function");
    expect(axe.version).toMatch(/^\d+\.\d+\.\d+/);
    const available = axe.getRules([...TAGS]);
    expect(available.length, "axe reported no rules for the requested tags").toBeGreaterThan(20);
  });

  for (const section of SECTION_NAMES) {
    for (const state of STATE_NAMES) {
      it(`${section} / ${state} has no violation at wcag2a..wcag22aa`, async () => {
        const found = await violationsFor(sectionHtml(section, state));
        expect(found, describeViolations(`${section} / ${state}`, found)).toEqual([]);
      });
    }
  }

  it("is NON-VACUOUS: axe reports the violations it is here to catch", async () => {
    // If the harness silently returned `[]` for everything the eighty assertions above
    // would pass over any markup at all. Each probe below is a deliberate violation of a
    // rule that `axe.getRules(TAGS)` actually reports, asserted BY RULE ID rather than by
    // "length > 0" — a count assertion passes when some unrelated rule fires, so it
    // proves the harness is noisy rather than proving it catches this defect.
    const image = await violationsFor(`<img src="x.png">`);
    expect(image.map((v) => v.id)).toContain("image-alt");

    // Structure: a non-`li` child of a list. Covers the section markup's use of lists.
    const badList = await violationsFor(`<ul><div>not a list item</div></ul>`);
    expect(badList.map((v) => v.id)).toContain("list");

    // Accessible name on a control — the class of defect this gate found in Overview.
    const unnamed = await violationsFor(`<button type="button"></button>`);
    expect(unnamed.map((v) => v.id)).toContain("button-name");

    // Label association, which every form state in the eight depends on.
    const orphanInput = await violationsFor(`<input type="text">`);
    expect(orphanInput.map((v) => v.id)).toContain("label");

    // `aria-*` validity, since the sections lean on aria-live/aria-describedby/aria-label.
    const badAria = await violationsFor(`<div role="button" tabindex="0" aria-labelledbye="nope">x</div>`);
    expect(badAria.map((v) => v.id)).toContain("aria-valid-attr");
  });

  it("disables a rule only where jsdom cannot decide it, and says which", () => {
    // The disabled list is asserted so it cannot grow quietly. Adding to it is then a
    // reviewed change with a stated reason, not a way to make a red gate green.
    expect([...UNDECIDABLE_IN_JSDOM].sort()).toEqual(["color-contrast", "target-size"]);
    // And the one that matters is covered elsewhere rather than dropped.
    expect(UNDECIDABLE_IN_JSDOM).toContain("color-contrast");
  });
});

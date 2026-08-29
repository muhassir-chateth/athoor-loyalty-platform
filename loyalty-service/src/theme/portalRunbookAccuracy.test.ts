/**
 * THE 30.2 RUNBOOK MUST AGREE WITH THE TEMPLATES IT DESCRIBES.
 *
 * `docs/ops/portal-30-2-manual-runbook.md` tells an operator the exact Page
 * handles to create, the exact template to select for each, and the exact heading
 * each page should show. Those tables are the operator's only reference — if one
 * cell is wrong, the outcome is a 404 or a page that renders **without the
 * portal**, and the second failure is silent.
 *
 * Task 24 already paid for this lesson once: a transcribed markup constant cannot
 * see a change in the file that actually ships, so the suite stayed green while
 * the shipped template carried the defect. A runbook is a transcription too. This
 * test re-derives every value from `theme/templates/page.my-athoor*.liquid` and
 * requires the document to match.
 *
 * It deliberately checks the document rather than only the templates: the
 * templates are already covered by `portalRouteContract.test.ts`. What is
 * unguarded is the gap between them and the instructions a human will follow.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const RUNBOOK = join(REPO_ROOT, "docs", "ops", "portal-30-2-manual-runbook.md");
const TEMPLATES = join(REPO_ROOT, "theme", "templates");

/** Strip Liquid comments so prose inside them cannot be read as code. */
function code(body: string): string {
  return body.replace(
    /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
    "",
  );
}

interface Derived {
  file: string;
  suffix: string;
  pageTitle: string;
  sectionName: string;
  navKey: string;
}

function derived(): Derived[] {
  return readdirSync(TEMPLATES)
    .filter((f) => f.startsWith("page.my-athoor") && f.endsWith(".liquid"))
    .sort()
    .map((file) => {
      const src = code(readFileSync(join(TEMPLATES, file), "utf8"));
      const grab = (key: string) =>
        src.match(new RegExp(`${key}:\\s*'([^']*)'`))?.[1] ?? "";
      const sectionName = grab("section_name");
      return {
        file,
        suffix: file.slice("page.".length, -".liquid".length),
        pageTitle: grab("page_title"),
        sectionName,
        navKey: grab("nav_key") || sectionName,
      };
    });
}

const runbook = () => readFileSync(RUNBOOK, "utf8");

describe("the 30.2 runbook matches the templates it describes", () => {
  it("names every shipped portal template", () => {
    const doc = runbook();
    for (const d of derived()) {
      expect(doc, `runbook must name ${d.file}`).toContain(d.file);
    }
  });

  it("states the correct handle and template suffix for each page", () => {
    const doc = runbook();
    for (const d of derived()) {
      // handle === suffix is the contract; the runbook must show it as such.
      expect(doc, `runbook must contain the handle \`${d.suffix}\``).toContain(
        `\`${d.suffix}\``,
      );
    }
  });

  it("pairs each handle with the heading that page actually renders", () => {
    // ASSOCIATION, not presence. An earlier version asked only whether the
    // heading appeared *somewhere* in the document, and the non-vacuity run broke
    // it: "Your orders" occurs in three places, so corrupting one table cell left
    // the test green on an unrelated occurrence. The operator reads a row, so the
    // row is what must be right.
    //
    // The headings come from `page_title:` in the template, never from the Shopify
    // Page title — an operator checking the wrong string would pass a broken page.
    // Scope to the headings table by its own header row. Searching the whole
    // document found the Page-objects table instead, where the suffix and the
    // handle are identical adjacent cells, so "the cell after the handle" was the
    // handle again. The table has to be identified, not guessed at.
    const lines = runbook().split("\n");
    const header = lines.findIndex(
      (l) => l.includes("Heading the page must show") && l.includes("Nav item highlighted"),
    );
    expect(header, "the runbook must contain the headings table").toBeGreaterThan(-1);

    const table = lines
      .slice(header + 2) // skip the header and its `|---|` separator
      .filter((l) => l.trimStart().startsWith("|"));
    const rows = table.slice(0, table.findIndex((l) => !l.includes("`")) + 1 || undefined);

    for (const d of derived()) {
      expect(d.pageTitle, `${d.file} must pass page_title`).not.toBe("");

      const row = rows.find((l) => l.includes(`\`${d.suffix}\``));
      expect(row, `the headings table needs a row for \`${d.suffix}\``).toBeDefined();

      const cells = (row as string).split("|").map((c) => c.trim());
      const at = cells.findIndex((c) => c === `\`${d.suffix}\``);
      expect(at, `\`${d.suffix}\` must be its own cell`).toBeGreaterThan(-1);
      expect(
        cells[at + 1],
        `the cell after \`${d.suffix}\` must be its rendered heading`,
      ).toBe(d.pageTitle);
    }
  });

  it("records the two sub-views that highlight a parent nav item", () => {
    const subViews = derived().filter((d) => d.navKey !== d.sectionName);
    // order-detail -> orders, activity -> rewards. If either stopped differing,
    // the runbook's "bold rows are deliberate" note would be misleading.
    expect(subViews.map((d) => `${d.sectionName}->${d.navKey}`).sort()).toEqual([
      "activity->rewards",
      "order-detail->orders",
    ]);
    const doc = runbook();
    for (const d of subViews) {
      expect(doc).toContain(`\`${d.suffix}\``);
    }
  });

  it("is right that no template reads the Shopify Page title or content", () => {
    // The runbook tells the operator the title is admin-facing only and the body
    // must be blank. Both claims rest on this.
    for (const d of derived()) {
      const src = code(readFileSync(join(TEMPLATES, d.file), "utf8"));
      expect(src, `${d.file} must not read page.title`).not.toContain("page.title");
      expect(src, `${d.file} must not read page.content`).not.toContain("page.content");
    }
  });

  it("quotes the portal settings group verbatim from the theme", () => {
    // §5 asks the operator to paste this into the preview theme. If it drifted
    // from the repository copy, the preview theme would stop matching what 31.2
    // later applies to live.
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "theme", "config", "settings_schema.json"), "utf8"),
    ) as Array<{ name?: string; settings?: Array<Record<string, unknown>> }>;
    const group = schema.find((g) => g.name === "My Athoor Portal");
    expect(group, "the theme must declare the My Athoor Portal group").toBeDefined();

    const doc = runbook();
    for (const setting of group?.settings ?? []) {
      if (typeof setting.id === "string") {
        expect(doc, `runbook must quote the ${setting.id} setting`).toContain(
          `"id": "${setting.id}"`,
        );
      }
    }
    // The default must be shown as false; an operator pasting `true` would
    // release the portal to every signed-in customer on that theme.
    expect(doc).toContain('"default": false');
  });

  it("keeps the destructive endpoints marked as must-not-trigger", () => {
    // Derived from the shipped section sources: these three exist and would act
    // on real customer data. The runbook must warn about each by name.
    const doc = runbook();
    for (const path of ["/redeem", "/profile/erasure-request", "/profile/export"]) {
      expect(doc, `runbook must warn about ${path}`).toContain(path);
    }
    expect(doc).toContain("must NOT be exercised");
    expect(doc).toContain("must NOT be submitted");
  });
});

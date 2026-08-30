/**
 * THE ONE TOOL THAT WRITES TO THE LIVE THEME MUST NOT BE ABLE TO WRITE ANYTHING ELSE.
 *
 * Every other tool refuses `role: main`; this one requires it, so the protection is inverted:
 * it must be incapable of touching a path the owner did not approve. That matters more now
 * than when 31.2 was written, because the 30-day return-policy sweep put FIVE more modified
 * files in the repo. An unconstrained push would ship a policy change inside a portal release
 * — and the owner explicitly held the aria-label hunks back for a separate release, so the
 * working-tree header.liquid is not safe to push either.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOnly, verifyStored } from "../../scripts/theme/portal-live-push.mjs";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./portalFixtures.js";

const SCRIPT = join(REPO_ROOT, "loyalty-service", "scripts", "theme", "portal-live-push.mjs");
const APPROVED = [
  ...git(["diff", "--diff-filter=A", "--name-only",
    "32eaca022c140bee9c7451813c735cd1c3389878", "HEAD", "--", "theme/"])
    .map((p) => p.replace(/^theme\//, "")),
  "config/settings_schema.json",
  "sections/header.liquid",
].sort();
function git(args: string[]): string[] {
  const out = execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return out === "" ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
}
const src = readFileSync(SCRIPT, "utf8");

describe("31.4 live push guards", () => {
  it("accepts exactly the two approved paths", () => {
    const r = resolveOnly(APPROVED.join(","));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    expect(r.paths).toEqual(APPROVED);
  });

  it("refuses any path outside the approved list", () => {
    for (const bad of [
      "config/settings_data.json",          // the return-policy sweep
      "templates/index.json",               // the return-policy sweep
      "layout/theme.liquid",                // D3-protected
      "assets/athoor-custom.css",           // owner-protected
      "config/settings_schema.json,templates/product.json",
    ]) {
      const r = resolveOnly(bad);
      expect(r.ok, `${bad} must be refused`).toBe(false);
    }
  });

  it("refuses globs outright (31.2)", () => {
    for (const g of ["*", "config/*", "sections/*.liquid", "config/settings_?chema.json"]) {
      const r = resolveOnly(g);
      expect(r.ok, `${g} must be refused`).toBe(false);
      expect(r.reason).toMatch(/glob|approved/i);
    }
  });

  it("refuses an empty selection rather than defaulting to everything", () => {
    for (const empty of ["", "   ", undefined, null]) {
      expect(resolveOnly(empty as unknown as string).ok).toBe(false);
    }
  });

  it("hardcodes the approved list to the artefact's two paths", () => {
    // If the approved list is ever widened, that must be a visible source change reviewed
    // against a fresh approval — not a runtime argument.
    for (const p of APPROVED) expect(src, `${p} must be in the tool's approved list`).toContain(`"${p}"`);
    expect(src).toContain("const APPROVED_PATHS");
    expect(APPROVED.length, "the closure is 28 additive + 2 modified").toBe(30);
  });

  it("requires the live role, an explicit push confirmation, and a drift check", () => {
    expect(src, "must require role main").toContain("halted_not_the_live_theme");
    expect(src, "must require an explicit confirmation to write").toContain("I-APPROVE");
    expect(src, "must stop if live drifted since the 31.1 backup")
      .toContain("halted_live_drifted_since_backup");
    expect(src, "must verify the asset key list did not change")
      .toContain("halted_asset_list_changed");
    expect(src, "must read staged bytes from theme-push/").toContain('"theme-push"');
  });

  // -- verifyStored --------------------------------------------------------
  // The first live run halted on config/settings_schema.json after 8 polled reads. The write
  // had SUCCEEDED — live held 23 groups and content semantically identical to the staged file,
  // differing by EIGHT BYTES because Shopify reformats theme config JSON on write.
  describe("verifyStored", () => {
    it("accepts byte-identical text", () => {
      const r = verifyStored("sections/header.liquid", "<p>a</p>", "<p>a</p>");
      expect(r.ok).toBe(true);
      expect(r.mode).toBe("byte-identical");
    });

    it("accepts JSON that Shopify only reformatted", () => {
      const staged = '{"a":1,"b":[1,2]}';
      const stored = '{\n  "b": [1, 2],\n  "a": 1\n}\n';
      const r = verifyStored("config/settings_schema.json", staged, stored);
      expect(r.ok, r.mode).toBe(true);
      expect(r.mode).toBe("json-content-identical-shopify-reformatted");
    });

    it("still REJECTS JSON whose content actually differs", () => {
      // The whole risk of relaxing byte equality is accepting a wrong document.
      for (const stored of ['{"a":2,"b":[1,2]}', '{"a":1}', '{"a":1,"b":[1,2,3]}', '[]']) {
        const r = verifyStored("config/settings_schema.json", '{"a":1,"b":[1,2]}', stored);
        expect(r.ok, `${stored} must be rejected`).toBe(false);
      }
    });

    it("rejects unparseable JSON rather than passing it", () => {
      const r = verifyStored("config/settings_schema.json", '{"a":1}', "not json");
      expect(r.ok).toBe(false);
      expect(r.mode).toBe("json-unparseable");
    });

    it("does NOT relax byte equality for Liquid or other text assets", () => {
      const r = verifyStored("sections/header.liquid", "<p>a</p>", "<p>a</p> ");
      expect(r.ok, "a byte difference in Liquid is a real difference").toBe(false);
      expect(r.mode).toBe("bytes-differ");
    });
  });

  it("guards main() so importing it cannot push to live", () => {
    expect(src).toContain("import.meta.url === `file://${process.argv[1]}`");
  });
});

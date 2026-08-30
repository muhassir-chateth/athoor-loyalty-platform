/**
 * TASK 31.1 MUST BE INCAPABLE OF WRITING TO THE LIVE THEME, AND ITS FILE SET MUST BE
 * DERIVED RATHER THAN TYPED.
 *
 * -- WHY THIS IS A STATIC CHECK ----------------------------------------------
 * `portal-live-backup.mjs` is the only tool in the repo that points at the live theme
 * (180956594515). Every other tool refuses `role: main` outright. A backup tool has to
 * read live, so the protection cannot be "never touch live" — it has to be "cannot
 * write". A promise in a comment is not that; a check on the bytes is.
 *
 * -- WHY THE PARTITION MATTERS ----------------------------------------------
 * The portal's theme footprint splits in two, and the split is the whole safety model:
 *   ADDED    files -> pushed by `portal-preview-push` (--diff-filter=A). Nothing to back
 *                     up; restoring means deleting.
 *   MODIFIED files -> backed up by this tool (--diff-filter=M) before any push.
 * If those sets ever overlap, a file would be both "new" and "modified" and the restore
 * path would be ambiguous. If they leave a gap, a live file would be changed with no
 * backup. Both are asserted here against real git history rather than assumed.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modifiedThemeFiles, assetKeyFor } from "../../scripts/theme/portal-live-backup.mjs";
import { REPO_ROOT } from "./portalFixtures.js";

const SCRIPT = join(REPO_ROOT, "loyalty-service", "scripts", "theme", "portal-live-backup.mjs");
const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";

function git(args: string[]): string[] {
  const out = execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return out === "" ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("31.1 live backup tool", () => {
  it("contains no mutating HTTP method at all", () => {
    const source = readFileSync(SCRIPT, "utf8");
    for (const verb of ["PUT", "POST", "DELETE", "PATCH"]) {
      expect(source, `must not be able to ${verb} to the live theme`).not.toContain(`"${verb}"`);
      expect(source).not.toContain(`'${verb}'`);
    }
    // The only fetch in the file must be the read helper, with no `method` option.
    const fetches = source.split("fetch(").length - 1;
    expect(fetches, "exactly one fetch call, and it is a GET").toBe(1);
    expect(source).not.toMatch(/method:\s*["'`]/);
  });

  it("derives its file set from git history, not a hardcoded list", () => {
    const derived = modifiedThemeFiles();
    const fromGit = git(["diff", "--diff-filter=M", "--name-only", PRE_PORTAL_COMMIT, "HEAD", "--", "theme/"]);
    expect([...derived].sort()).toEqual([...fromGit].sort());
    // Guard against a vacuous pass if history is ever rewritten to an empty diff.
    expect(derived.length).toBeGreaterThan(0);
  });

  it("partitions the portal's theme footprint with the push tool: no overlap, no gap", () => {
    const modified = new Set(modifiedThemeFiles());
    const added = new Set(git(["diff", "--diff-filter=A", "--name-only", PRE_PORTAL_COMMIT, "HEAD", "--", "theme/"]));
    const overlap = [...modified].filter((f) => added.has(f));
    expect(overlap, "a file cannot be both added and modified").toEqual([]);

    // Every theme file the portal touches must land in exactly one of the two sets.
    const allTouched = git(["diff", "--name-only", PRE_PORTAL_COMMIT, "HEAD", "--", "theme/"]);
    const covered = allTouched.filter((f) => modified.has(f) || added.has(f));
    expect(covered.sort(), "every touched theme file is either backed up or newly added")
      .toEqual([...allTouched].sort());
    expect(modified.size + added.size).toBe(allTouched.length);
  });

  it("maps repo paths to Shopify asset keys, and refuses anything outside theme/", () => {
    expect(assetKeyFor("theme/sections/header.liquid")).toBe("sections/header.liquid");
    expect(assetKeyFor("theme/config/settings_schema.json")).toBe("config/settings_schema.json");
    expect(() => assetKeyFor("loyalty-service/src/index.ts")).toThrow();
  });
});

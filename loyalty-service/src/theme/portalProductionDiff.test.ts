/**
 * TASK 31.2 — THE STAGED PRODUCTION DIFF MUST CARRY THE PORTAL HUNKS AND NOTHING ELSE.
 *
 * -- WHY theme-push/ EXISTS AT ALL -------------------------------------------
 * 31.2: "Push always runs from `theme-push/`, never from the working tree." The working
 * tree's `sections/header.liquid` is NOT safe to push: it also carries seven `aria-label`
 * additions from a different task. Pushing the working-tree file would ship that
 * unrelated change to the live theme under cover of a portal release.
 *
 * -- THE MIXED HUNK ---------------------------------------------------------
 * Live and repo differ by five hunks. Two are portal (the flag-gated
 * `portal-account-href` render on the menu-drawer and header account links, task 19.3).
 * Three are a11y aria-labels. The fifth is BOTH, on the same `<a>` tag. 31.2 requires the
 * portal hunk to be separated or the file not pushed, so `theme-push/` is built from the
 * pulled LIVE bytes with only the portal substitutions applied.
 *
 * These assertions are what stop that separation from quietly eroding: the most likely
 * "tidy-up" is someone copying the working-tree file over the staged one, which would
 * look like a simplification and would silently re-introduce the a11y hunks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const PUSH = join(REPO_ROOT, "theme-push");
const BACKUPS = join(REPO_ROOT, "backups", "live-180956594515");

function latestLiveDir(): string {
  const dirs = readdirSync(BACKUPS).filter((d) => statSync(join(BACKUPS, d)).isDirectory()).sort();
  expect(dirs.length, "a 31.1 live backup must exist").toBeGreaterThan(0);
  return join(BACKUPS, dirs[dirs.length - 1] as string);
}
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full, base) : [full.slice(base.length + 1)];
  });
}
const read = (p: string) => readFileSync(p, "utf8");

const EXPECTED = ["config/settings_schema.json", "sections/header.liquid"];

describe("31.2 staged production diff", () => {
  const live = latestLiveDir();

  it("stages exactly the two live files the portal modifies — no globs, no extras", () => {
    expect(walk(PUSH).sort()).toEqual([...EXPECTED].sort());
  });

  it("header.liquid is built from LIVE bytes, not from the working tree", () => {
    const staged = read(join(PUSH, "sections/header.liquid"));
    const worktree = read(join(REPO_ROOT, "theme", "sections", "header.liquid"));
    // The working tree carries the a11y hunks, so staged MUST differ from it. If these
    // ever match, someone has copied the working-tree file over the staged one.
    expect(staged).not.toBe(worktree);
  });

  it("carries the portal hunks", () => {
    const staged = read(join(PUSH, "sections/header.liquid"));
    expect(staged.split("'portal-account-href'").length - 1, "two gated links").toBe(2);
    expect(staged).toContain("portal_drawer_href != blank");
    expect(staged).toContain("portal_account_href != blank");
    // With the flag off the gate is blank, so the pre-existing branches must survive
    // verbatim — that is what makes the rendered href byte-identical to today's.
    expect(staged).toContain("{%- elsif customer -%}{{ routes.account_url }}{%- else -%}/pages/account-landing{%- endif -%}");
  });

  it("carries NO unrelated a11y change", () => {
    const staged = read(join(PUSH, "sections/header.liquid"));
    const liveHdr = read(join(live, "sections/header.liquid"));
    expect(staged.split("aria-label").length, "aria-label count must equal live's").toBe(
      liveHdr.split("aria-label").length,
    );
    expect(staged, "the a11y hunk's liquid must be absent").not.toContain("account_link_label");
  });

  it("settings_schema.json appends the portal group and preserves all 22 live groups", () => {
    const stagedGroups = JSON.parse(read(join(PUSH, "config/settings_schema.json")));
    const liveGroups = JSON.parse(read(join(live, "config/settings_schema.json")));
    expect(liveGroups).toHaveLength(22);
    expect(stagedGroups).toHaveLength(23);
    expect(JSON.stringify(stagedGroups.slice(0, 22))).toBe(JSON.stringify(liveGroups));
    expect(stagedGroups[22].name).toBe("My Athoor Portal");
    const ids = stagedGroups[22].settings.map((s: { id?: string }) => s.id).filter(Boolean);
    expect(ids).toEqual(["portal_enabled", "portal_allowlist"]);
  });

  it("no staged file is empty or truncated", () => {
    for (const rel of EXPECTED) {
      const staged = read(join(PUSH, rel));
      const liveFile = read(join(live, rel));
      expect(staged.length, `${rel} must not shrink below live`).toBeGreaterThanOrEqual(liveFile.length);
    }
  });
});

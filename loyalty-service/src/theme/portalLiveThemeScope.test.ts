/**
 * THE LIVE-THEME BLAST-RADIUS GATE — D3, Requirements 22.5, 22.8, 18.10.
 *
 * ── WHAT IT FIXES ───────────────────────────────────────────────────────────
 * The portal is allowed to modify a *very* small number of files that already
 * existed in the live theme. Everything else it ships is a new file. This gate
 * enumerates that set, so widening it becomes a deliberate act with a failing
 * test attached rather than a line in a diff nobody re-reads.
 *
 * ── THE `layout/theme.liquid` DISCREPANCY, SETTLED ──────────────────────────
 * Task 31.8 is titled "prepare the single permitted `layout/theme.liquid` hunk",
 * and design §25.3's coexistence table says the same. **The portal does not
 * touch `layout/theme.liquid` at all.** The account link it repoints lives in
 * `sections/header.liquid`; `snippets/portal-account-href.liquid` records why in
 * its own header ("the design predates the header being split into its own
 * section").
 *
 * That distinction matters beyond tidiness. The three deferred D3 items — the
 * four parser-blocking head scripts, Font Awesome, async GSAP — are all in
 * `layout/theme.liquid`. Asserting that file is byte-identical to the pre-portal
 * commit is what proves D3 was honoured, and it is a stronger statement than the
 * task text's wording. The task text is stale; the implementation is correct.
 * Neither Liquid file is edited to make the wording match — the wording is wrong.
 *
 * ── READ FROM GIT, NOT FROM DISK ────────────────────────────────────────────
 * The "before" is the pre-portal commit, exactly as task 29.10's dependency gate
 * does it. An allowlist on disk can be edited to make a red gate green; a commit
 * cannot. This needs full history, so `portal-ci.yml` sets `fetch-depth: 0`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

/** The last commit of the pre-portal world (see `portalDependencyGate.test.ts`). */
const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";

/**
 * Pre-existing theme files the portal is permitted to modify.
 *
 * `sections/header.liquid`      — the one flag-gated account-link change (19.3/31.8).
 * `config/settings_schema.json` — the two settings that make the flag flippable.
 *
 * Both are *modifications*, which is why neither belongs to task 30.1's push of
 * "the portal's own new files" and both are governed by 31.1's byte-exact backup
 * and 31.2's scoped diff.
 */
const PERMITTED_MODIFICATIONS: readonly string[] = [
  "theme/config/settings_schema.json",
  "theme/sections/header.liquid",
];

/**
 * Live theme files modified by an APPROVED change set that is NOT the portal.
 *
 * The portal's own blast radius stays pinned at two above. This list exists so an
 * ACCIDENTAL modification of any other live file still fails: a file must be declared in
 * exactly one of these two lists, and adding it here is a deliberate, reviewable act.
 * Raising the portal's number to swallow these would have destroyed that property.
 *
 * Change set: the customer-facing return window 14 -> 30 days.
 * Inventory and the deliberate exclusions: docs/ops/return-policy-30-day-sweep.md
 * These need their own backup, diff and approval before any live push — 31.2 forbids a push
 * carrying unrelated hunks, so theme-push/ deliberately excludes them.
 */
const PERMITTED_NON_PORTAL_MODIFICATIONS: readonly string[] = [
  "theme/config/settings_data.json",
  "theme/sections/athoor-tasting-notes.liquid",
  "theme/templates/index.json",
  "theme/templates/product.json",
  "theme/templates/product.product-identity.json",
];

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Pre-existing theme files changed between the pre-portal commit and HEAD. */
function modifiedThemeFiles(): string[] {
  return git(["diff", "--name-only", "--diff-filter=M", PRE_PORTAL_COMMIT, "HEAD", "--", "theme/"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

/** The `portal_on` computation, lifted from a snippet's `{%- liquid … -%}` block. */
function gateBlock(snippet: string): string {
  const body = readFileSync(join(REPO_ROOT, "theme", "snippets", snippet), "utf8");
  const start = body.indexOf("assign portal_on = false");
  const end = body.indexOf("endif", body.indexOf("hay contains needle"));
  expect(start, `${snippet} must compute portal_on`).toBeGreaterThan(-1);
  expect(end, `${snippet} must close the allowlist branch`).toBeGreaterThan(start);
  return body
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

describe("live-theme blast radius", () => {
  it("has the pre-portal baseline commit available", () => {
    // A shallow clone makes every other test here silently unrunnable.
    expect(git(["rev-parse", PRE_PORTAL_COMMIT]).trim()).toBe(PRE_PORTAL_COMMIT);
  });

  // KNOWN LIMITATION, recorded rather than glossed: `modifiedThemeFiles()` derives from
  // `git diff … HEAD`, so it sees COMMITTED changes only. An uncommitted edit to an
  // undeclared live theme file does NOT fail this test — verified by trying it. That is
  // tolerable here because a push runs from committed bytes, but it is exactly the
  // false-green the D3 assertion below avoids by reading the file from DISK. If this guard
  // is ever relied on pre-commit, it needs the same treatment.
  //
  // Non-vacuity was therefore proved through the declaration, not the working tree:
  // dropping a declared file fails this test; moving a policy file into the portal's list
  // fails three.
  it("modifies only DECLARED pre-existing theme files, portal and non-portal kept apart", () => {
    const declared = [...PERMITTED_MODIFICATIONS, ...PERMITTED_NON_PORTAL_MODIFICATIONS].sort();
    expect(modifiedThemeFiles()).toEqual(declared);
  });

  it("keeps the PORTAL's own blast radius at exactly two files", () => {
    // The portal's radius is what D3 and 31.2 constrain. It must not grow just because a
    // different approved change set touched more of the live theme.
    expect(PERMITTED_MODIFICATIONS).toHaveLength(2);
    const modified = new Set(modifiedThemeFiles());
    for (const f of PERMITTED_MODIFICATIONS) expect(modified.has(f), `${f} must be modified`).toBe(true);
  });

  it("declares each modified file exactly once", () => {
    const overlap = PERMITTED_MODIFICATIONS.filter((f) => PERMITTED_NON_PORTAL_MODIFICATIONS.includes(f));
    expect(overlap, "a file cannot belong to both change sets").toEqual([]);
  });

  it("leaves layout/theme.liquid byte-identical to the pre-portal commit", () => {
    // This is the D3 assertion. The deferred head-script, Font Awesome and GSAP
    // work all lives in this file; if any of it had crept in, this fails.
    //
    // BASELINE FROM GIT, CURRENT FROM DISK — and the asymmetry is deliberate.
    // Reading both sides from commits is what the first draft of this gate did,
    // and the non-vacuity run caught it: editing the file on disk left the test
    // green, because `HEAD` had not moved. A gate that cannot see the edit a
    // developer is about to commit reports a false green at exactly the moment it
    // is being consulted. So the baseline stays untamperable (a commit), while
    // "current" is the bytes that actually exist now.
    const before = git(["show", `${PRE_PORTAL_COMMIT}:theme/layout/theme.liquid`]);
    const onDisk = readFileSync(join(REPO_ROOT, "theme", "layout", "theme.liquid"), "utf8");
    expect(onDisk, "layout/theme.liquid differs from the pre-portal commit (D3)").toBe(before);

    // And separately: no committed change either, so a clean tree cannot hide one.
    expect(git(["show", "HEAD:theme/layout/theme.liquid"])).toBe(before);
  });

  it("keeps the two portal_on gate blocks textually identical", () => {
    // `portal-account-href.liquid` claims the gate is "written once, here and in
    // portal-chrome" — it is in fact written twice, and its own header names the
    // failure that a drifted copy would cause: "an account icon pointing at the
    // portal while the portal pages themselves still render page.content".
    // Nothing enforced that until now.
    expect(gateBlock("portal-account-href.liquid")).toBe(gateBlock("portal-chrome.liquid"));
  });

  it("emits the portal account href only for a signed-in customer with the flag on", () => {
    const body = readFileSync(
      join(REPO_ROOT, "theme", "snippets", "portal-account-href.liquid"),
      "utf8",
    );
    expect(body).toContain("if portal_on and customer");
    expect(body).toContain("echo '/pages/my-athoor'");
  });

  it("keeps the header's pre-portal account fallbacks on every changed link", () => {
    // With the flag off the captured href is blank, so each link must still fall
    // through to the branch that shipped before. Losing a fallback would change
    // the live header while the portal is supposed to be invisible.
    const header = readFileSync(join(REPO_ROOT, "theme", "sections", "header.liquid"), "utf8");
    const links = [...header.matchAll(/<a href="\{%-?\s*if portal_[a-z_]*href[\s\S]*?"/g)];
    expect(links.length, "expected the two flag-gated account links").toBe(2);
    for (const link of links) {
      expect(link[0]).toContain("routes.account_url");
    }
    // The two pre-existing anonymous destinations, one per link.
    expect(header).toContain("routes.account_login_url");
    expect(header).toContain("/pages/account-landing");
  });
});

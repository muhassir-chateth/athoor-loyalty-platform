/**
 * A FILE STAGED FOR THE LIVE THEME MUST NOT RENDER A SNIPPET THAT IS NOT ON THE LIVE THEME.
 *
 * -- THE INCIDENT THIS EXISTS TO PREVENT -------------------------------------
 * The approved 31.3 diff was two files: config/settings_schema.json and
 * sections/header.liquid. Both were pushed to live theme 180956594515. The approval artefact
 * said, in my own words, that the portal's other 28 theme files "are not part of this diff"
 * because they are additive and carry no live counterpart.
 *
 * That reasoning was wrong, and it broke the live storefront.
 *
 * The staged header.liquid contains `{% render 'portal-account-href' %}`. That snippet is one
 * of the 28 ADDED files, so it was not on live. Shopify does not fail quietly: it renders the
 * error INTO THE ATTRIBUTE. Every page of the live store served
 *
 *   href="Liquid error (sections/header line 970): Could not find asset
 *         snippets/portal-account-href.liquid"
 *
 * as the account link — homepage, product pages, collections and /pages/rewards. Rolled back
 * from the 31.1 backup; live verified byte-identical to baseline afterwards.
 *
 * Neither the per-file hash check nor the asset-key-list check could have caught it: both
 * files were written exactly as intended. The push was byte-perfect and still wrong, because
 * correctness here is a property of the SET, not of each file. Hence this test.
 *
 * The dependency is computed offline from git — no network — so it runs in CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";
const PUSH = join(REPO_ROOT, "theme-push");

function git(args: string[]): string[] {
  const out = execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return out === "" ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
}
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full, base) : [full.slice(base.length + 1)];
  });
}
/** Snippet names a Liquid file renders or includes. */
export function renderedSnippets(liquid: string): string[] {
  const names = new Set<string>();
  for (const m of liquid.matchAll(/\{%-?\s*(?:render|include)\s+'([^']+)'/g)) names.add(m[1] as string);
  for (const m of liquid.matchAll(/\{%-?\s*(?:render|include)\s+"([^"]+)"/g)) names.add(m[1] as string);
  return [...names].sort();
}

describe("31.4 staged files must not depend on snippets absent from live", () => {
  // Files the portal ADDS: present on the draft theme, absent from live until pushed.
  const addedToLive = new Set(git([
    "diff", "--diff-filter=A", "--name-only", PRE_PORTAL_COMMIT, "HEAD", "--", "theme/",
  ]));
  const stagedPaths = walk(PUSH);

  it("finds staged files and a non-empty added set (guards a vacuous pass)", () => {
    expect(stagedPaths.length).toBeGreaterThan(0);
    expect(addedToLive.size).toBeGreaterThan(0);
  });

  it("every snippet a staged file renders is either already live or staged alongside it", () => {
    const unmet: string[] = [];
    for (const rel of stagedPaths) {
      if (!rel.endsWith(".liquid")) continue;
      for (const name of renderedSnippets(readFileSync(join(PUSH, rel), "utf8"))) {
        const repoPath = `theme/snippets/${name}.liquid`;
        const isNew = addedToLive.has(repoPath);
        const alsoStaged = stagedPaths.includes(`snippets/${name}.liquid`);
        if (isNew && !alsoStaged) unmet.push(`${rel} renders '${name}' — new file, not in this push`);
      }
    }
    expect(
      unmet,
      "a staged file renders a snippet that will not exist on live: Shopify renders the error " +
        "into the output, which is what broke the storefront sitewide",
    ).toEqual([]);
  });

  it("extracts render targets from both quote styles and whitespace-control tags", () => {
    // Non-vacuity for the extractor: if it silently matched nothing, the check above passes.
    const sample = `{% render 'a' %}{%- render "b" -%}{% include 'c' %}{%- assign x = 1 -%}`;
    expect(renderedSnippets(sample)).toEqual(["a", "b", "c"]);
    expect(renderedSnippets("no renders here")).toEqual([]);
  });
});

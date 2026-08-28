/**
 * DRIFT GUARDS FOR `scripts/theme/portal-preview-push.mjs` (task 30.1's runner).
 *
 * The script pins two constants that describe the repository:
 *
 *   `PRE_PORTAL_COMMIT`  — the commit the "new files" set is measured from
 *   `EXPECTED_NEW_FILES` — how many files that set is expected to contain
 *
 * Pinning is deliberate: it turns a surprise into a halt instead of a silent
 * push. But a pin that nothing checks goes stale, and a stale pin fails at
 * deploy time, against production, with a token loaded — the worst moment to
 * discover it. These tests move that failure to `npm test`.
 *
 * They also stop the script and the repository gates from disagreeing about
 * which commit "before the portal" means. Two sources of truth for that would
 * eventually diverge, and the one used at deploy time is the one nobody runs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const SCRIPT = join(REPO_ROOT, "loyalty-service", "scripts", "theme", "portal-preview-push.mjs");

function script(): string {
  return readFileSync(SCRIPT, "utf8");
}

/** Reads a pinned `const NAME = <value>;` out of the script source. */
function pinned(name: string): string {
  const match = script().match(new RegExp(`const ${name}\\s*=\\s*"?([^";\\n]+)"?;`));
  expect(match, `${name} must be pinned in the script`).not.toBeNull();
  return (match as RegExpMatchArray)[1].trim();
}

/** The same measurement the script performs, run independently here. */
function addedThemeFileCount(baseline: string): number {
  return execFileSync(
    "git",
    ["diff", "--diff-filter=A", "--name-only", baseline, "HEAD", "--", "theme/"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

describe("portal-preview-push.mjs pins match the repository", () => {
  it("measures from the same pre-portal commit the gates use", () => {
    // `portalLiveThemeScope.test.ts` and `portalDependencyGate.test.ts` use this
    // commit too. If the script measured from a different one, its file set and
    // the gates' notion of "added by the portal" would quietly differ.
    expect(pinned("PRE_PORTAL_COMMIT")).toBe("32eaca022c140bee9c7451813c735cd1c3389878");
  });

  it("pins a file count equal to what git actually reports", () => {
    const expected = Number(pinned("EXPECTED_NEW_FILES"));
    expect(Number.isInteger(expected)).toBe(true);
    expect(addedThemeFileCount(pinned("PRE_PORTAL_COMMIT"))).toBe(expected);
  });

  it("refuses to write without --apply, and halts on the live theme", () => {
    // Static checks, because exercising these needs a live Shopify token. They
    // assert the guards are still present after an edit; the behaviour itself was
    // verified against a real store by driving each refusal path.
    const src = script();
    expect(src).toContain("halted_target_is_live_theme");
    expect(src).toContain('role === "main"');
    // Planning is the default: writes happen only under `--apply`.
    expect(src).toContain("if (!apply && !rollback)");
  });

  it("takes the token from the environment only", () => {
    const src = script();
    expect(src).toContain("requireSecretFromEnv");
    // If the token were read from args it could land in shell history and in any
    // process listing on the deploying machine.
    expect(src).not.toMatch(/args\s*\[\s*["']token["']\s*\]/);
  });

  it("reads file bytes from a git commit, never from the working tree", () => {
    const src = script();
    // §25.5: an unrelated local edit must be resolved with the owner before a
    // push, so the push must not be able to pick one up.
    expect(src).toContain('execFileSync("git", ["show"');
    expect(src).not.toMatch(/readFileSync\(\s*join\(REPO_ROOT,\s*["']theme["']/);
  });
});

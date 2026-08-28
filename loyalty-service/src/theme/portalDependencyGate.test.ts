/**
 * TASK 29.10 — the dependency gate.
 * Validates Requirements 19.2, 19.8, 19.10.
 *
 * ── WHAT "BYTE-IDENTICAL BEFORE AND AFTER THE PORTAL" MEANS HERE ─────────────
 * 29.10 asks that `npm ls --omit=dev` be byte-identical before and after the portal.
 * Running `npm ls` from a test would be slow, would depend on an installed tree, and
 * would compare today's output against nothing — there is no recorded "before".
 *
 * But the "before" is not lost: it is in git. `8fe248a` is the commit that first
 * changed dependencies for the portal (task 7.1, which added esbuild), so its parent
 * `32eaca0` is the last commit of the pre-portal world. This gate reads that
 * commit's `package.json` and `package-lock.json` with `git show` and compares.
 *
 * That is stronger than the alternative, which is a transcribed allowlist. An
 * allowlist has to be edited whenever it is wrong, and an allowlist edited to make a
 * red gate green proves nothing. The pre-portal manifest cannot be edited: it is a
 * commit that is already in the history.
 *
 * ── WHY THE PRODUCTION TREE IS THE THING THAT MATTERS ────────────────────────
 * Requirement 19.8: the portal SHALL add no runtime npm dependency. A devDependency
 * is a build-time tool that never reaches Render and never reaches a browser; a
 * runtime dependency is code that runs in production, costs cold-start time on a free
 * instance, and carries a supply-chain surface. So the production set is asserted
 * IDENTICAL, and the dev set is asserted to have grown by exactly two named, exactly
 * pinned tools.
 *
 * SAFETY: `git show` and file reads. Read-only, local, no network, no install.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

/**
 * The last commit before the portal touched dependencies.
 *
 * `8fe248a` — "feat(portal): task 7.1 — esbuild multi-entry build into theme assets"
 * — is the first commit in which the portal changed `package.json`. Its parent is
 * therefore the pre-portal baseline by construction rather than by choice.
 */
const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";

/** The two devDependencies the portal is permitted to add, and only these. */
const PERMITTED_NEW_DEV_DEPENDENCIES: readonly string[] = ["axe-core", "esbuild"];

interface Manifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

/**
 * Read a file as it existed at a commit. Read-only; never checks anything out.
 *
 * ── ON A SHALLOW CLONE THIS FAILS LOUDLY, AND THAT IS THE DESIGN ─────────────
 * `actions/checkout` defaults to `fetch-depth: 1`, which fetches the tip commit and
 * no history — so `git show 32eaca0:…` reports "exists on disk, but not in
 * 32eaca0…" and this gate cannot run. `portal-ci.yml` therefore sets
 * `fetch-depth: 0`, and the message below names that as the fix.
 *
 * The tempting alternative is to catch the error and skip the comparison. Rejected:
 * 29.10 requires a build-failing gate, and a gate that passes whenever it is unable
 * to check anything is the precise failure mode these tasks exist to prevent. A gate
 * that cannot run must be red, not green.
 */
function showAtCommit(commit: string, path: string): string {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Task 29.10 cannot read the pre-portal baseline ${commit}:${path}.\n` +
        `\n` +
        `This is almost always a SHALLOW CLONE: the commit's tree is not present.\n` +
        `  - In CI: 'portal-ci.yml' must keep 'fetch-depth: 0' on actions/checkout.\n` +
        `  - Locally: run 'git fetch --unshallow' (or 'git fetch --depth=1000').\n` +
        `\n` +
        `The gate deliberately FAILS rather than skipping. 29.10 is specified as\n` +
        `build-failing, and a dependency gate that passes when it cannot compare\n` +
        `anything would let a new runtime dependency through unnoticed.\n` +
        `\n` +
        `git reported: ${detail}`,
    );
  }
}

function parseManifest(text: string): Manifest {
  const parsed = JSON.parse(text) as Partial<Manifest>;
  return {
    dependencies: parsed.dependencies ?? {},
    devDependencies: parsed.devDependencies ?? {},
  };
}

const CURRENT = parseManifest(readFileSync(join(REPO_ROOT, "loyalty-service", "package.json"), "utf8"));
const BEFORE = parseManifest(showAtCommit(PRE_PORTAL_COMMIT, "loyalty-service/package.json"));

describe("Task 29.10 — the dependency gate (Requirements 19.2, 19.8, 19.10)", () => {
  it("CI checks out full history, without which this gate cannot run", () => {
    // The coupling is real and easy to break by accident: someone tidying the
    // workflow removes `fetch-depth: 0`, CI goes red on a confusing `git show`
    // error, and the quickest way to green looks like deleting this file. Asserting
    // the workflow line here means the dependency is documented at both ends.
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "portal-ci.yml"),
      "utf8",
    );
    expect(workflow, "portal-ci.yml no longer requests full history").toMatch(/fetch-depth:\s*0/);
    // And it must be on the checkout step, not somewhere incidental.
    const checkoutBlock = /uses:\s*actions\/checkout@v4([\s\S]*?)(?=\n {6}- name:)/.exec(workflow)?.[1] ?? "";
    expect(checkoutBlock, "fetch-depth: 0 is not on the checkout step").toMatch(/fetch-depth:\s*0/);
  });

  it("the pre-portal baseline is readable, so the comparison below is real", () => {
    // If `git show` failed or returned an empty manifest, every comparison after this
    // would compare against `{}` and pass trivially.
    expect(Object.keys(BEFORE.dependencies).length, "pre-portal manifest has no dependencies").toBeGreaterThan(
      0,
    );
    expect(Object.keys(BEFORE.devDependencies).length).toBeGreaterThan(0);
    // And it must be the commit claimed, not a moving reference.
    const resolved = execFileSync("git", ["rev-parse", PRE_PORTAL_COMMIT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(resolved).toBe(PRE_PORTAL_COMMIT);
  });

  it("Requirement 19.8 — the production dependency set is UNCHANGED, name and range", () => {
    // The central assertion. Not "no new dependency" but "the same dependencies, at
    // the same ranges" — a widened range is a new dependency tree without a new name.
    expect(CURRENT.dependencies).toEqual(BEFORE.dependencies);
  });

  it("the production dependency set is exactly the seven it has always been", () => {
    // Stated independently of the diff so the failure message names the packages. A
    // reader of a failing build should not have to run `git show` to see what changed.
    expect(Object.keys(CURRENT.dependencies).sort()).toEqual([
      "@types/node",
      "@types/pg",
      "fastify",
      "pg",
      "pg-boss",
      "typescript",
      "zod",
    ]);
  });

  it("the resolved production tree in the lockfile is unchanged too", () => {
    // `package.json` ranges being equal does not prove the resolved tree is equal —
    // that is what a lockfile is for, and it is the lockfile `npm ci` installs. So the
    // comparison is over every production package the lock resolves.
    interface Lock {
      readonly packages?: Readonly<Record<string, { readonly version?: string; readonly dev?: boolean }>>;
    }
    const productionEntries = (text: string): Record<string, string> => {
      const lock = JSON.parse(text) as Lock;
      const out: Record<string, string> = {};
      for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        // `dev: true` marks a devDependency-only package. The root entry ("") has no
        // version of its own worth comparing.
        if (path === "" || entry.dev === true) continue;
        out[path] = entry.version ?? "";
      }
      return out;
    };
    const before = productionEntries(showAtCommit(PRE_PORTAL_COMMIT, "loyalty-service/package-lock.json"));
    const after = productionEntries(
      readFileSync(join(REPO_ROOT, "loyalty-service", "package-lock.json"), "utf8"),
    );
    // Report as sorted name lists first: a diff of 200 versions is unreadable, and the
    // question "did a package appear or vanish" is the one that matters most.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Then the versions, which catches a silent bump inside an existing range.
    const drifted = Object.keys(after)
      .filter((name) => after[name] !== before[name])
      .map((name) => `${name}: ${before[name] ?? "(absent)"} → ${after[name] ?? "(absent)"}`);
    expect(drifted, `production packages changed version:\n  ${drifted.join("\n  ")}`).toEqual([]);
  });

  it("exactly two devDependencies were added, and they are the two 29.10 names", () => {
    const added = Object.keys(CURRENT.devDependencies).filter(
      (name) => !Object.prototype.hasOwnProperty.call(BEFORE.devDependencies, name),
    );
    expect(added.sort()).toEqual([...PERMITTED_NEW_DEV_DEPENDENCIES]);
  });

  it("no pre-portal devDependency was removed or had its range changed", () => {
    // The other half of "the only added devDependencies are …": a gate that only looks
    // at additions would not notice a removal, and removing `fast-check` would silently
    // disable every property test in the suite.
    for (const [name, range] of Object.entries(BEFORE.devDependencies)) {
      expect(CURRENT.devDependencies[name], `devDependency ${name} changed or was removed`).toBe(range);
    }
  });

  it("both added devDependencies are pinned EXACTLY — no ^, no ~, no range", () => {
    // Requirement 19.10. An exact pin is what makes a build reproducible: `^0.28.2`
    // installs whatever 0.x is newest at install time, so two `npm ci` runs a week
    // apart can produce different bytes in `theme/assets/`, and the artefact committed
    // to the theme would stop matching the one CI builds.
    for (const name of PERMITTED_NEW_DEV_DEPENDENCIES) {
      const range = CURRENT.devDependencies[name];
      expect(range, `${name} is not declared at all`).toBeDefined();
      expect(range, `${name} must be exactly pinned, found "${String(range)}"`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
    // The values, recorded so a bump is a deliberate edit to this test as well.
    expect(CURRENT.devDependencies["esbuild"]).toBe("0.28.2");
    expect(CURRENT.devDependencies["axe-core"]).toBe("4.13.0");
  });

  it("neither added tool can reach production: both are devDependencies only", () => {
    for (const name of PERMITTED_NEW_DEV_DEPENDENCIES) {
      expect(Object.prototype.hasOwnProperty.call(CURRENT.dependencies, name), `${name} is a runtime dep`).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(CURRENT.devDependencies, name)).toBe(true);
    }
    // And the lockfile must agree, because `npm ci --omit=dev` reads the lock, not the
    // manifest. A package marked non-dev in the lock ships to Render.
    interface Lock {
      readonly packages?: Readonly<Record<string, { readonly dev?: boolean }>>;
    }
    const lock = JSON.parse(
      readFileSync(join(REPO_ROOT, "loyalty-service", "package-lock.json"), "utf8"),
    ) as Lock;
    for (const name of PERMITTED_NEW_DEV_DEPENDENCIES) {
      const entry = lock.packages?.[`node_modules/${name}`];
      expect(entry, `${name} is absent from the lockfile`).toBeDefined();
      expect(entry?.dev, `${name} is not marked dev in the lockfile — it would ship`).toBe(true);
    }
  });

  it("neither added tool is imported by any server source file", () => {
    // The structural reason they cannot reach production. `esbuild` is invoked by a
    // build script; `axe-core` is imported by one test. Neither may appear in `src/`,
    // because `src/` is what `tsc` compiles into `dist/` and `dist/` is what runs.
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    for (const path of walk(join(REPO_ROOT, "loyalty-service", "src"))) {
      // A test file may import `axe-core`; that is the point of it.
      if (path.endsWith(".test.ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const name of PERMITTED_NEW_DEV_DEPENDENCIES) {
        if (new RegExp(`from\\s+["']${name}["']|require\\(\\s*["']${name}["']`).test(text)) {
          offenders.push(`${path}: imports ${name}`);
        }
      }
    }
    expect(offenders, `dev-only tools imported from runtime source:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the portal ships no runtime dependency to the BROWSER either", () => {
    // The third place a dependency could hide. Requirement 19.2: the portal's bundles
    // are self-contained, so a bundle must not contain a bare module specifier or a
    // CDN import that would fetch code at run time.
    const core = readFileSync(join(REPO_ROOT, "theme", "assets", "athoor-portal-core.js"), "utf8");
    expect(core).not.toMatch(/\bimport\s+.*\bfrom\s+["'](?!\.)/);
    expect(core).not.toMatch(/\bimport\s*\(\s*["']https?:/);
    expect(core).not.toMatch(/\brequire\s*\(/);
    expect(core).not.toMatch(/unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev/);
  });

  it("is NON-VACUOUS: the comparison detects an added or widened dependency", () => {
    // Proves the equality assertions above would actually fail, rather than comparing
    // two references to the same object or two empty maps.
    const widened = { ...CURRENT.dependencies, zod: "^4.0.0" };
    expect(widened).not.toEqual(BEFORE.dependencies);
    const addedRuntime = { ...CURRENT.dependencies, lodash: "^4.17.21" };
    expect(addedRuntime).not.toEqual(BEFORE.dependencies);
    const removed = { ...CURRENT.dependencies };
    delete (removed as Record<string, string>)["zod"];
    expect(removed).not.toEqual(BEFORE.dependencies);
    // And the pin check rejects every non-exact form.
    const pin = /^\d+\.\d+\.\d+$/;
    expect(pin.test("0.28.2")).toBe(true);
    expect(pin.test("^0.28.2")).toBe(false);
    expect(pin.test("~0.28.2")).toBe(false);
    expect(pin.test(">=0.28.2")).toBe(false);
    expect(pin.test("0.28.x")).toBe(false);
    expect(pin.test("latest")).toBe(false);
    expect(pin.test("*")).toBe(false);
    // The two sets really do differ by exactly two, so the addition test is measuring
    // something rather than comparing a set with itself.
    expect(Object.keys(CURRENT.devDependencies).length - Object.keys(BEFORE.devDependencies).length).toBe(2);
  });
});

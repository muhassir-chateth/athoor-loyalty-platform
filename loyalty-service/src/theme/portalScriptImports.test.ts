/**
 * EVERY HELPER A THEME SCRIPT USES MUST ACTUALLY BE IMPORTED.
 *
 * ── THE FAILURE THIS EXISTS TO PREVENT ──────────────────────────────────────
 * `portal-pages.mjs` called `finish(...)` without importing it. Node raises
 * `finish is not defined` only when that line executes — and in this script the
 * `finish` calls sit on the reporting path, AFTER the `PUT`. So the first time it
 * ran against production it wrote the page successfully and then crashed while
 * reporting, leaving a real production mutation with no verification output. The
 * write had to be confirmed by a separate read.
 *
 * `node --check` cannot catch this: the file is syntactically perfect. Nor can the
 * suite, because these scripts are guarded against executing on import. A static
 * cross-check of used-versus-imported names is what closes it.
 *
 * Applied to all three theme scripts, not just the one that broke, because they
 * share the helper module and the same shape of mistake is available in each.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const SCRIPTS = join(REPO_ROOT, "loyalty-service", "scripts", "theme");
const HELPERS = join(REPO_ROOT, "loyalty-service", "scripts", "migration");

const THEME_SCRIPTS = [
  "portal-pages.mjs",
  "portal-preview-push.mjs",
  "portal-settings-apply.mjs",
  // 31.1's tool touches the LIVE theme, so it gets the same guard as the rest.
  "portal-live-backup.mjs",
];

/** Names a helper module exports. */
function exportsOf(file: string): Set<string> {
  const src = readFileSync(join(HELPERS, file), "utf8");
  return new Set(
    [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]),
  );
}

/** Names a script imports from a given helper module. */
function importedFrom(src: string, module: string): Set<string> {
  const re = new RegExp(
    String.raw`import\s*\{([^}]+)\}\s*from\s*"\.\./migration/` + module + String.raw`"`,
  );
  const m = src.match(re);
  if (!m) return new Set();
  return new Set(m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
}

/** Strip comments and string literals so prose cannot look like a call. */
function executable(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe.each(THEME_SCRIPTS)("%s imports everything it uses", (script) => {
  const src = readFileSync(join(SCRIPTS, script), "utf8");
  const body = executable(src);

  it.each(["_shared.mjs", "_envIdentity.mjs"])(
    "declares every %s helper it calls",
    (module) => {
      const available = exportsOf(module);
      const imported = importedFrom(src, module);
      // A name is "used" if it appears as a call or a bare reference in code.
      const used = [...available].filter((name) =>
        new RegExp(String.raw`\b` + name + String.raw`\b`).test(body),
      );
      const missing = used.filter((n) => !imported.has(n));
      expect(
        missing,
        `${script} uses ${missing.join(", ")} from ${module} without importing it — ` +
          "this throws only when the line executes, which for a reporting helper " +
          "means after any write has already happened",
      ).toEqual([]);
    },
  );

  it("guards main() so importing the module cannot execute it", () => {
    // Two of these scripts previously called main() at top level, so importing
    // either would run a production tool inside the test suite.
    expect(src).toContain("import.meta.url === `file://${process.argv[1]}`");
  });
});

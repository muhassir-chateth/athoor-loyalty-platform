/**
 * Structural guard for Req 10.7a — migration must stay REFUSED over HTTP.
 *
 * `POST /v1/admin/operations/migration` returns 501 `migration_not_enabled`
 * because the M0–M2 cutover must run as an operator script: the M0 export is the
 * rollback anchor, and an HTTP-triggered migration could run without one.
 *
 * Task 33 committed concrete production clients for that cutover
 * (`migrationShopifyClient.ts`, `metafieldRestoreClient.ts`,
 * `serviceController.ts`). The moment those exist, there is a real temptation to
 * "just wire them up" in boot glue, which would quietly turn the 501 into an
 * implementable route. This test reads the SOURCE TEXT of `index.ts` and
 * `app.ts` and fails if any migration module is imported there, so the refusal
 * stays structurally true and migration cannot drift into boot wiring.
 *
 * Companion to `boot.wiring.test.ts`, which asserts the opposite direction (the
 * Pg-backed implementations that MUST be wired).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

const bootFiles = ["index.ts", "app.ts"] as const;

/** Every module under `src/migration/` that must never be imported by boot glue. */
const MIGRATION_MODULES = [
  "m0Export",
  "m1Backfill",
  "rollback",
  "backupWriter",
  "migrationShopifyClient",
  "metafieldRestoreClient",
  "serviceController",
  "shopifyMigrationSupport",
] as const;

describe("Req 10.7a — migration stays out of the HTTP boot path", () => {
  for (const file of bootFiles) {
    const source = readFileSync(join(srcDir, file), "utf8");

    it(`${file} imports nothing from src/migration/`, () => {
      // Any import/re-export/dynamic import whose specifier mentions migration/.
      expect(source).not.toMatch(/from\s+["'][^"']*\bmigration\//);
      expect(source).not.toMatch(/import\s*\(\s*["'][^"']*\bmigration\//);
      expect(source).not.toMatch(/require\s*\(\s*["'][^"']*\bmigration\//);
    });

    for (const moduleName of MIGRATION_MODULES) {
      it(`${file} does not import ${moduleName}`, () => {
        expect(source).not.toContain(`${moduleName}.js`);
      });
    }
  }

  it("no concrete migration client is constructed in boot glue", () => {
    for (const file of bootFiles) {
      const source = readFileSync(join(srcDir, file), "utf8");
      expect(source).not.toMatch(/new\s+ShopifyGraphqlMigrationClient\s*\(/);
      expect(source).not.toMatch(/new\s+ShopifyGraphqlMetafieldRestoreClient\s*\(/);
      expect(source).not.toMatch(/new\s+OperatorSuspendedServiceController\s*\(/);
      expect(source).not.toMatch(/runM0Export|runM1Backfill|runMetafieldRollback/);
    }
  });

  it("index.ts still refuses migration by throwing MigrationNotEnabledError", () => {
    const source = readFileSync(join(srcDir, "index.ts"), "utf8");
    expect(source).toMatch(/runMigration\s*:\s*\(\)\s*=>\s*\{[\s\S]{0,120}throw new MigrationNotEnabledError\(\)/);
  });
});

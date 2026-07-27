/**
 * Reachability regression for tier-change history (task 46).
 *
 * PROBLEM THIS TEST SOLVES
 * ------------------------
 * `tier_change_history` was created by a migration and READ by the profile data
 * source to build `tier_change` milestones, but nothing ever wrote a row. Every
 * unit test passed, the milestone type was fully typed and even ranked in the
 * timeline sort, and the gap only surfaced when a genuine Shopify `orders/paid`
 * promoted a real member and the table stayed empty (task 45).
 *
 * A test that injects its own fake cannot catch that class of defect, so this
 * one reads the SOURCE TEXT and asserts the write is present where the tier is
 * persisted, and that the writer is not duplicated.
 *
 * Validates: Requirements 17.8, 17.9
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (relative: string): string => readFileSync(join(__dirname, "..", relative), "utf8");

const tierHistorySource = src("tier/tierHistory.ts");
const orderSource = src("earning/order.ts");
const clawbackSource = src("earning/clawback.ts");
const tierSource = src("tier/tier.ts");
const profileSource = src("profile/fragranceProfile.ts");

describe("tier history is written where the tier is persisted (task 46)", () => {
  it("the paid-order path imports and calls recordTierChange", () => {
    expect(orderSource).toMatch(/import\s.*recordTierChange.*from\s+"\.\.\/tier\/tierHistory\.js"/);
    expect(orderSource).toMatch(/recordTierChange\(/);
  });

  it("the paid-order path records the change on the same executor as the tier UPDATE", () => {
    // Both statements must run on `executor` — the caller's transaction client —
    // or the history row could commit independently of the promotion.
    const updateIndex = orderSource.indexOf("UPDATE_CUSTOMER_TOTALS_SQL, [customerId");
    const recordIndex = orderSource.indexOf("recordTierChange(\n    executor,");
    expect(updateIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(updateIndex);
  });

  it("the clawback downgrade branch records the change too", () => {
    expect(clawbackSource).toMatch(
      /import\s.*recordTierChange.*from\s+"\.\.\/tier\/tierHistory\.js"/,
    );
    expect(clawbackSource).toMatch(/recordTierChange\(executor, customerId/);
  });

  it("the milestone consumer still reads the table the writer populates", () => {
    // If either side is renamed without the other, the milestone silently
    // disappears again — which is precisely the original defect.
    expect(profileSource).toMatch(/FROM tier_change_history/);
    expect(tierHistorySource).toMatch(/INSERT INTO tier_change_history/);
  });
});

describe("tierHistory is the single writer (task 46)", () => {
  it("no other module issues an INSERT INTO tier_change_history", () => {
    // Duplicating the SQL is how one call site ends up writing and another not.
    for (const [name, source] of [
      ["earning/order.ts", orderSource],
      ["earning/clawback.ts", clawbackSource],
      ["profile/fragranceProfile.ts", profileSource],
      ["tier/tier.ts", tierSource],
    ] as const) {
      expect(source, `${name} must delegate the write, not inline the SQL`).not.toMatch(
        /INSERT INTO tier_change_history/,
      );
    }
  });

  it("tier.ts stays pure — it must not gain a database write", () => {
    expect(tierSource).not.toMatch(/INSERT INTO/);
    expect(tierSource).not.toMatch(/executor|\bpool\b/);
  });

  it("the writer guards on an actual change rather than writing unconditionally", () => {
    expect(tierHistorySource).toMatch(/if \(from === to\)/);
    expect(tierHistorySource).toMatch(/return false;/);
  });
});

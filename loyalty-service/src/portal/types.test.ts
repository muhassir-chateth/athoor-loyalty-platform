/**
 * Tests for the shared N1–N16 wire contract (spec task 5.6).
 *
 * WHAT IS TESTED HERE, AND WHAT IS TESTED BY `tsc`
 * -----------------------------------------------
 * The type-level invariants — no `customerId` on any response, no `email` on the
 * identity write, money never typed as a number, N5's wishlist field tied to the
 * shipped reconcile response — are asserted INSIDE `types.ts` itself, because
 * `tsconfig.json` excludes `src/**\/*.test.ts` and vitest transpiles without
 * type-checking, so a type assertion written here would be checked by nothing.
 * Each of those three was confirmed to fail `tsc` when deliberately broken, and
 * restored.
 *
 * This file covers what only runtime can cover: the money FORMAT, the numeric
 * bounds §6.3 states, the order-id pattern, and one source-level scan that
 * catches a `customerId` on a REQUEST type (which the response-union assertion
 * in `types.ts` does not range over).
 *
 * SAFETY: pure. No Postgres, no Shopify, no network, no production.
 *
 * Validates: Requirements 20.6, 21.1, 21.7
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { WISHLIST_RECONCILE_MAX_ITEMS } from "../profile/wishlistReconcileContract.js";
import {
  MONEY_GBP_PATTERN,
  PORTAL_CATALOG_MAX_IDS,
  PORTAL_EXPORT_CONTENT_TYPE,
  PORTAL_ORDERS_MAX_PAGE_SIZE,
  PORTAL_ORDER_ID_PATTERN,
  PORTAL_REDEMPTIONS_PAGE_SIZE,
  PORTAL_WISHLIST_MAX_ITEMS,
  isMoneyGBP,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TYPES_SOURCE = readFileSync(join(__dirname, "types.ts"), "utf8");

describe("MoneyGBP format (design §6.2 — GBP values are 2-dp decimal strings)", () => {
  it("accepts a two-decimal-place decimal string", () => {
    for (const value of ["0.00", "5.50", "184.00", "1234567.89", "-5.50", "-0.01"]) {
      expect(isMoneyGBP(value), value).toBe(true);
    }
  });

  it("rejects a bare integer, because a 2-dp contract that tolerates a missing .00 is not a contract", () => {
    for (const value of ["184", "0", "-5"]) {
      expect(isMoneyGBP(value), value).toBe(false);
    }
  });

  it("rejects the wrong number of fractional digits", () => {
    for (const value of ["184.0", "184.000", "184."]) {
      expect(isMoneyGBP(value), value).toBe(false);
    }
  });

  it("rejects currency symbols, thousands separators and exponents", () => {
    for (const value of ["£184.00", "1,184.00", "1.84e2", "184.00 GBP", " 184.00", "184.00 "]) {
      expect(isMoneyGBP(value), value).toBe(false);
    }
  });

  it("rejects a number — the representation the shipped /v1/balance uses, and the easy mistake", () => {
    expect(isMoneyGBP(184)).toBe(false);
    expect(isMoneyGBP(184.0)).toBe(false);
  });

  it("rejects the values Requirement 16.8 forbids ever reaching a customer", () => {
    for (const value of [undefined, null, NaN, "undefined", "null", "NaN", ""]) {
      expect(isMoneyGBP(value), String(value)).toBe(false);
    }
  });

  it("is anchored, so a valid amount embedded in other text does not pass", () => {
    expect(isMoneyGBP("total 184.00")).toBe(false);
    expect(isMoneyGBP("184.00\n")).toBe(false);
    expect(MONEY_GBP_PATTERN.source.startsWith("^")).toBe(true);
    expect(MONEY_GBP_PATTERN.source.endsWith("$")).toBe(true);
  });

  it("carries no /g flag, so repeated calls do not depend on a retained lastIndex", () => {
    expect(MONEY_GBP_PATTERN.global).toBe(false);
    expect(isMoneyGBP("184.00")).toBe(true);
    expect(isMoneyGBP("184.00")).toBe(true);
  });
});

describe("order id pattern (§6.3 N2 — path ^\\d{1,20}$ or 400 invalid_order_reference)", () => {
  it("accepts 1 to 20 digits", () => {
    expect(PORTAL_ORDER_ID_PATTERN.test("6")).toBe(true);
    expect(PORTAL_ORDER_ID_PATTERN.test("6543210987")).toBe(true);
    expect(PORTAL_ORDER_ID_PATTERN.test("1".repeat(20))).toBe(true);
  });

  it("rejects 21 digits, non-digits, a Shopify GID and an empty value", () => {
    for (const value of [
      "1".repeat(21),
      "gid://shopify/Order/6543210987",
      "65432 10987",
      "-1",
      "6.0",
      "",
    ]) {
      expect(PORTAL_ORDER_ID_PATTERN.test(value), value).toBe(false);
    }
  });
});

describe("bounds stated by design §6.3", () => {
  it("caps an orders page at 20 (Req 6.12)", () => {
    expect(PORTAL_ORDERS_MAX_PAGE_SIZE).toBe(20);
  });

  it("caps a catalogue lookup at 50 ids", () => {
    expect(PORTAL_CATALOG_MAX_IDS).toBe(50);
  });

  it("pages redemptions at 20", () => {
    expect(PORTAL_REDEMPTIONS_PAGE_SIZE).toBe(20);
  });

  it("returns the export as JSON", () => {
    expect(PORTAL_EXPORT_CONTENT_TYPE).toBe("application/json");
  });
});

describe("the wishlist cap is ONE constant, not two", () => {
  /*
   * The consolidation that matters: N5 rejects at 500 with
   * `409 wishlist_limit_reached`, and reconcile already bounds its array at 500.
   * Two independent 500s would let a customer exceed either bound by alternating
   * between the two endpoints, and the drift would be invisible until then.
   */
  it("re-exports the reconcile cap rather than restating it", () => {
    expect(PORTAL_WISHLIST_MAX_ITEMS).toBe(WISHLIST_RECONCILE_MAX_ITEMS);
    expect(PORTAL_WISHLIST_MAX_ITEMS).toBe(500);
  });

  it("declares no second numeric literal for the cap", () => {
    const declarations = TYPES_SOURCE.split("\n").filter((line) =>
      /^export const PORTAL_WISHLIST_MAX_ITEMS\s*=/.test(line),
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain("WISHLIST_RECONCILE_MAX_ITEMS");
    expect(declarations[0]).not.toMatch(/\d/);
  });
});

describe("rule 1 — no contract type carries a customer identifier", () => {
  /*
   * The distributive type assertion in `types.ts` ranges over the RESPONSE union.
   * A request type is not in that union, so this scan is what stops a
   * `customerId` arriving on the way IN — which is the direction that would let a
   * client nominate a customer and reopen the IDOR hole `CustomerScope` closes.
   */
  it("declares no customerId property anywhere in the module", () => {
    const propertyDeclaration = /^\s*(?:readonly\s+)?customerId\s*\??\s*:/m;
    expect(propertyDeclaration.test(TYPES_SOURCE)).toBe(false);
  });

  it("declares no customer-identifier-shaped property under another name", () => {
    const aliases = /^\s*(?:readonly\s+)?(?:customer_id|shopifyCustomerId|customerGid)\s*\??\s*:/m;
    expect(aliases.test(TYPES_SOURCE)).toBe(false);
  });
});

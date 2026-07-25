/**
 * Property-based test for the Entitlement Resolver — Property 14 (Entitlement
 * gating correctness), Requirement 18.3 / task 15.3.
 *
 *   Property 14: a benefit is granted to a customer IFF
 *     tierRank(current) >= tierRank(benefit.min_qualifying_tier);
 *   an unqualified invocation performs NO state change and returns (reports)
 *   the required tier.
 *
 * This is a VERIFICATION task: the approved implementation
 * ({@link DbEntitlementResolver}) is NOT changed. The resolver is exercised
 * against a fully self-contained, stateful in-memory fake {@link Queryable}
 * (defined below) that models the three tables the resolver touches —
 * `customers`, `benefits`, and the off-ledger `benefit_requests`. NO live/
 * production database or Shopify Admin API is contacted.
 *
 * The "current tier" is the customer's derived/retained tier, computed exactly
 * as the resolver computes it via {@link advanceTier}(row.tier, spend) — the
 * tier module is the single source of truth for tier ordering, so the test
 * never hardcodes tier ranks; it re-uses {@link tierRank}/{@link advanceTier}.
 *
 * fast-check generates arbitrary customer tiers (via cached tier + lifetime
 * spend) and arbitrary benefit catalogues (each with an arbitrary
 * min_qualifying_tier and active flag), then asserts:
 *   - resolveBenefits returns a benefit IFF it is active AND the biconditional
 *     tierRank(current) >= tierRank(min) holds (Req 18.2/18.3, Property 14);
 *   - qualifies(key) is exactly that biconditional, independent of `active`
 *     (Req 18.3, Property 14);
 *   - requestBenefit on an UNqualified tier records no benefit_requests row,
 *     issues no INSERT, and throws carrying the exact required tier (Req 18.6);
 *   - requestBenefit on a qualified + enabled benefit records exactly one row
 *     whose recorded state is unchanged elsewhere (Req 18.5).
 *
 * **Validates: Requirements 18.3**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { TIERS, advanceTier, tierRank, type Tier } from "../tier/tier.js";
import {
  BenefitNotQualifiedError,
  DbEntitlementResolver,
} from "./entitlementResolver.js";

/* ------------------------- self-contained fake DB ------------------------- */

interface StoredCustomer {
  id: string;
  lifetime_spend_gbp: number;
  tier: string | null;
}

interface StoredBenefit {
  id: string;
  key: string;
  name: string;
  min_qualifying_tier: string;
  config: Record<string, unknown>;
  active: boolean;
}

interface StoredBenefitRequest {
  id: string;
  customer_id: string;
  benefit_id: string;
  status: string;
  requested_at: Date;
}

interface FakeDb {
  db: Queryable;
  requests: StoredBenefitRequest[];
  statements: string[];
}

/**
 * Builds a fully self-contained fake {@link Queryable} modelling the
 * `customers`, `benefits`, and `benefit_requests` tables and the exact four SQL
 * statements the resolver issues. Every statement text is recorded in
 * `statements` so tests can assert the deny paths write nothing and the ledger
 * is never touched.
 */
function makeDb(customer: StoredCustomer, benefits: StoredBenefit[]): FakeDb {
  const requests: StoredBenefitRequest[] = [];
  const statements: string[] = [];
  let seq = 0;

  const ok = <T extends QueryResultRow>(rows: T[], command = "SELECT"): QueryResult<T> => ({
    rows,
    rowCount: rows.length,
    command,
    oid: 0,
    fields: [],
  });

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(text.trim());

      // SELECT ... FROM customers WHERE id = $1
      if (/FROM customers/i.test(text)) {
        const id = values[0] as string;
        const row =
          id === customer.id
            ? [{ lifetime_spend_gbp: customer.lifetime_spend_gbp, tier: customer.tier }]
            : [];
        return ok(row as unknown as R[]);
      }

      // SELECT ... FROM benefits WHERE active = true
      if (/FROM benefits/i.test(text) && /active = true/i.test(text)) {
        const rows = benefits
          .filter((b) => b.active)
          .map((b) => ({
            key: b.key,
            name: b.name,
            min_qualifying_tier: b.min_qualifying_tier,
            config: b.config,
            active: b.active,
          }));
        return ok(rows as unknown as R[]);
      }

      // SELECT ... FROM benefits WHERE key = $1
      if (/FROM benefits/i.test(text) && /WHERE key/i.test(text)) {
        const key = values[0] as string;
        const b = benefits.find((x) => x.key === key);
        return ok(
          (b
            ? [
                {
                  id: b.id,
                  key: b.key,
                  name: b.name,
                  min_qualifying_tier: b.min_qualifying_tier,
                  config: b.config,
                  active: b.active,
                },
              ]
            : []) as unknown as R[],
        );
      }

      // INSERT INTO benefit_requests (...) RETURNING ...
      if (/INSERT INTO benefit_requests/i.test(text)) {
        seq += 1;
        const stored: StoredBenefitRequest = {
          id: `req-${seq}`,
          customer_id: values[0] as string,
          benefit_id: values[1] as string,
          status: "requested",
          requested_at: new Date(Date.UTC(2025, 0, 1) + seq * 1000),
        };
        requests.push(stored);
        return ok(
          [
            {
              id: stored.id,
              customer_id: stored.customer_id,
              benefit_id: stored.benefit_id,
              status: stored.status,
              requested_at: stored.requested_at,
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, requests, statements };
}

const CUST = "22222222-2222-2222-2222-222222222222";

/* -------------------------------- arbitraries ----------------------------- */

/** A recognized membership tier. */
const tierArb: fc.Arbitrary<Tier> = fc.constantFrom(...TIERS);

/**
 * A customer whose current (derived) tier is deterministic from its cached tier
 * plus lifetime spend. Both are generated arbitrarily; the "current" tier is
 * computed with the real {@link advanceTier}, never hardcoded.
 */
const customerArb: fc.Arbitrary<StoredCustomer> = fc.record({
  id: fc.constant(CUST),
  // Spend spans across every tier threshold (Bronze £0 … Royal_VIP £1500+).
  lifetime_spend_gbp: fc.nat({ max: 3000 }),
  // Cached tier may be a real tier, missing (null), or an unrecognized string
  // (advanceTier normalizes these to Bronze) — exercising the derived-tier path.
  tier: fc.oneof(
    tierArb as fc.Arbitrary<string | null>,
    fc.constant(null),
    fc.constant("legacy_unknown"),
  ),
});

/**
 * A catalogue of benefits with unique keys, each gated at an arbitrary tier and
 * independently enabled/disabled. `appExclusive` is intentionally left false
 * (no channel is passed) so Property 14 is isolated from channel gating.
 */
const benefitsArb: fc.Arbitrary<StoredBenefit[]> = fc
  .array(
    fc.record({
      min_qualifying_tier: tierArb as fc.Arbitrary<string>,
      active: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((rows) =>
    rows.map((r, i) => ({
      id: `b-${i}`,
      key: `benefit_${i}`,
      name: `Benefit ${i}`,
      min_qualifying_tier: r.min_qualifying_tier,
      config: {},
      active: r.active,
    })),
  );

/** The gating biconditional under test (Property 14), using the tier module. */
function isGranted(currentTier: Tier, minTier: string): boolean {
  return tierRank(currentTier) >= tierRank(minTier as Tier);
}

/* ------------------------------- properties ------------------------------- */

describe("Property 14: entitlement gating correctness (Req 18.3)", () => {
  it("resolveBenefits returns a benefit IFF it is active AND tier(c) >= min", async () => {
    await fc.assert(
      fc.asyncProperty(customerArb, benefitsArb, async (customer, benefits) => {
        const fake = makeDb(customer, benefits);
        const resolver = new DbEntitlementResolver(fake.db);

        const current = advanceTier(customer.tier, customer.lifetime_spend_gbp);
        const resolvedKeys = new Set(
          (await resolver.resolveBenefits(customer.id)).map((b) => b.key),
        );

        for (const b of benefits) {
          const expected = b.active && isGranted(current, b.min_qualifying_tier);
          expect(resolvedKeys.has(b.key)).toBe(expected);
        }

        // Read-only: no write statement of any kind was issued.
        expect(fake.statements.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
        expect(fake.requests.length).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("qualifies(key) equals tier(c) >= min, independent of the active flag", async () => {
    await fc.assert(
      fc.asyncProperty(customerArb, benefitsArb, async (customer, benefits) => {
        const fake = makeDb(customer, benefits);
        const resolver = new DbEntitlementResolver(fake.db);

        const current = advanceTier(customer.tier, customer.lifetime_spend_gbp);

        for (const b of benefits) {
          const qualifies = await resolver.qualifies(customer.id, b.key);
          expect(qualifies).toBe(isGranted(current, b.min_qualifying_tier));
        }

        // qualifies is read-only regardless of outcome.
        expect(fake.statements.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("requestBenefit on an UNqualified tier performs no state change and reports the required tier", async () => {
    await fc.assert(
      fc.asyncProperty(customerArb, benefitsArb, async (customer, benefits) => {
        const fake = makeDb(customer, benefits);
        const resolver = new DbEntitlementResolver(fake.db);

        const current = advanceTier(customer.tier, customer.lifetime_spend_gbp);

        // Only exercise the deny path: benefits gated strictly above the tier.
        const unqualified = benefits.filter(
          (b) => !isGranted(current, b.min_qualifying_tier),
        );

        for (const b of unqualified) {
          const error = await resolver
            .requestBenefit(customer.id, b.key)
            .then(() => null)
            .catch((e: unknown) => e);

          // Denied with the exact required tier carried on the error (Req 18.6).
          expect(error).toBeInstanceOf(BenefitNotQualifiedError);
          const nq = error as BenefitNotQualifiedError;
          expect(nq.requiredTier).toBe(b.min_qualifying_tier);
          expect(nq.currentTier).toBe(current);
          expect(nq.benefitKey).toBe(b.key);
        }

        if (unqualified.length > 0) {
          // NO benefit_requests row and NO INSERT was issued on any deny path,
          // and the ledger is never touched (off-ledger, Req 18.6).
          expect(fake.requests.length).toBe(0);
          expect(fake.statements.some((s) => /INSERT INTO benefit_requests/i.test(s))).toBe(false);
          expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("requestBenefit on a qualified + enabled benefit records exactly one row (Req 18.5)", async () => {
    await fc.assert(
      fc.asyncProperty(customerArb, benefitsArb, async (customer, benefits) => {
        const current = advanceTier(customer.tier, customer.lifetime_spend_gbp);

        // Pick the first benefit that is both qualified and enabled, if any.
        const grantable = benefits.find(
          (b) => b.active && isGranted(current, b.min_qualifying_tier),
        );
        fc.pre(grantable !== undefined);

        const fake = makeDb(customer, benefits);
        const resolver = new DbEntitlementResolver(fake.db);

        const request = await resolver.requestBenefit(customer.id, grantable!.key);

        expect(request.benefitKey).toBe(grantable!.key);
        expect(request.benefitId).toBe(grantable!.id);
        expect(request.customerId).toBe(customer.id);
        expect(request.status).toBe("requested");

        // Exactly one row recorded, and only in benefit_requests (never ledger).
        expect(fake.requests.length).toBe(1);
        const writes = fake.statements.filter((s) => /INSERT|UPDATE|DELETE/i.test(s));
        expect(writes.length).toBe(1);
        expect(writes.every((s) => /benefit_requests/i.test(s))).toBe(true);
        expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

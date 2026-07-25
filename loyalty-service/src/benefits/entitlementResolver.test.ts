/**
 * Unit tests for the Entitlement Resolver (task 15.2) — Requirement 18 and
 * design.md "Component 6: Entitlement Resolver".
 *
 * NO live/production database or Shopify Admin API is touched. The resolver is
 * exercised against a stateful in-memory fake {@link Queryable} that models the
 * three tables it reads/writes: `customers` (tier-driving row), `benefits`
 * (seeded, tier-gated definitions), and the off-ledger `benefit_requests`
 * table. The fake records every statement so tests can assert nothing is
 * written on the deny paths and that the ledger is never touched.
 *
 * Covers (Requirements 7.8, 18.2, 18.3, 18.5, 18.6; Property 14):
 *   - resolveBenefits returns exactly the ACTIVE Benefits the customer's tier
 *     qualifies for, gated by tier rank (Req 18.2);
 *   - a Benefit gated above the customer's tier is never returned/granted
 *     (Req 18.3, Property 14);
 *   - qualifies is the pure tier-rank predicate, independent of `active`
 *     (Req 18.3);
 *   - requestBenefit records exactly one benefit_requests row when a qualifying
 *     member invokes an enabled Benefit (Req 18.5), including a Royal_VIP member
 *     reaching a Royal_VIP-exclusive Benefit (Req 7.8);
 *   - an unqualified invocation performs NO state change and reports the
 *     required tier (Req 18.6);
 *   - a qualifying invocation of a disabled Benefit records nothing (Req 18.5).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  BenefitChannelNotAllowedError,
  BenefitDisabledError,
  BenefitNotFoundError,
  BenefitNotQualifiedError,
  CustomerNotFoundError,
  DbEntitlementResolver,
  EntitlementValidationError,
} from "./entitlementResolver.js";

/* --------------------------------- fakes ---------------------------------- */

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
  customers: Map<string, StoredCustomer>;
  benefits: StoredBenefit[];
  requests: StoredBenefitRequest[];
  statements: string[];
}

/**
 * Builds a fake Queryable modelling the `customers`, `benefits`, and
 * `benefit_requests` tables and the four SQL statements the resolver issues.
 * All statements are recorded in `statements` for write-isolation assertions.
 */
function makeDb(options: {
  customers?: StoredCustomer[];
  benefits?: StoredBenefit[];
  failInsert?: boolean;
  insertReturnsNoRow?: boolean;
} = {}): FakeDb {
  const customers = new Map<string, StoredCustomer>(
    (options.customers ?? []).map((c) => [c.id, c]),
  );
  const benefits = [...(options.benefits ?? [])];
  const requests: StoredBenefitRequest[] = [];
  const statements: string[] = [];
  let requestSeq = 0;

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

      if (/FROM customers/i.test(text)) {
        const id = values[0] as string;
        const c = customers.get(id);
        return ok(
          c
            ? ([{ lifetime_spend_gbp: c.lifetime_spend_gbp, tier: c.tier }] as unknown as R[])
            : ([] as unknown as R[]),
        );
      }

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

      if (/FROM benefits/i.test(text) && /WHERE key/i.test(text)) {
        const key = values[0] as string;
        const b = benefits.find((x) => x.key === key);
        return ok(
          b
            ? ([
                {
                  id: b.id,
                  key: b.key,
                  name: b.name,
                  min_qualifying_tier: b.min_qualifying_tier,
                  config: b.config,
                  active: b.active,
                },
              ] as unknown as R[])
            : ([] as unknown as R[]),
        );
      }

      if (/INSERT INTO benefit_requests/i.test(text)) {
        if (options.failInsert) {
          throw new Error("insert failed: connection reset");
        }
        if (options.insertReturnsNoRow) {
          return ok([] as unknown as R[], "INSERT");
        }
        requestSeq += 1;
        const stored: StoredBenefitRequest = {
          id: `req-${requestSeq}`,
          customer_id: values[0] as string,
          benefit_id: values[1] as string,
          status: "requested",
          requested_at: new Date(Date.UTC(2025, 0, 1) + requestSeq * 1000),
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

  return { db, customers, benefits, requests, statements };
}

const CUST = "11111111-1111-1111-1111-111111111111";

/** A representative seeded catalogue spanning every tier gate. */
function seedBenefits(): StoredBenefit[] {
  return [
    {
      id: "b-bronze",
      key: "welcome_note",
      name: "Welcome Note",
      min_qualifying_tier: "bronze",
      config: {},
      active: true,
    },
    {
      id: "b-silver",
      key: "silver_gift",
      name: "Silver Gift Wrap",
      min_qualifying_tier: "silver",
      config: {},
      active: true,
    },
    {
      id: "b-gold",
      key: "gold_sample",
      name: "Gold Complimentary Sample",
      min_qualifying_tier: "gold",
      config: {},
      active: true,
    },
    {
      id: "b-vip",
      key: "private_consultation",
      name: "Private Consultation Booking",
      min_qualifying_tier: "royal_vip",
      config: { bookable: true },
      active: true,
    },
    {
      id: "b-vip-disabled",
      key: "invitation_only_experiences",
      name: "Invitation-Only Experiences",
      min_qualifying_tier: "royal_vip",
      config: { roadmap: true },
      active: false,
    },
  ];
}

/* ----------------------------- resolveBenefits ---------------------------- */

describe("resolveBenefits: tier-gated active benefits (Req 18.2, Property 14)", () => {
  it("returns only active benefits the customer's tier qualifies for", async () => {
    // Gold customer (lifetime spend £900) qualifies for bronze/silver/gold, not VIP.
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 900, tier: "gold" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const benefits = await resolver.resolveBenefits(CUST);
    const keys = benefits.map((b) => b.key).sort();

    expect(keys).toEqual(["gold_sample", "silver_gift", "welcome_note"]);
    // The VIP-gated benefits are above the customer's tier — never returned.
    expect(keys).not.toContain("private_consultation");
  });

  it("returns every active benefit for a Royal_VIP member (Req 7.8)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const keys = (await resolver.resolveBenefits(CUST)).map((b) => b.key).sort();

    // All ACTIVE benefits, including the Royal_VIP-exclusive private consultation.
    expect(keys).toEqual(["gold_sample", "private_consultation", "silver_gift", "welcome_note"]);
    // The disabled VIP benefit is not active, so it is excluded.
    expect(keys).not.toContain("invitation_only_experiences");
  });

  it("returns only the bronze benefit for a Bronze customer", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 0, tier: "bronze" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const keys = (await resolver.resolveBenefits(CUST)).map((b) => b.key);
    expect(keys).toEqual(["welcome_note"]);
  });

  it("derives the tier from lifetime spend even when the cached tier is stale/lower", async () => {
    // Cached tier says bronze, but £900 lifetime spend derives gold; the derived
    // tier wins (advanceTier), matching the balance endpoint.
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 900, tier: "bronze" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const keys = (await resolver.resolveBenefits(CUST)).map((b) => b.key).sort();
    expect(keys).toEqual(["gold_sample", "silver_gift", "welcome_note"]);
  });

  it("does not write anything (read-only)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 900, tier: "gold" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await resolver.resolveBenefits(CUST);

    expect(fake.statements.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
    expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  it("throws when the customer does not exist", async () => {
    const fake = makeDb({ benefits: seedBenefits() });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.resolveBenefits(CUST)).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  it("rejects a blank customer id without issuing any query", async () => {
    const fake = makeDb({ benefits: seedBenefits() });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.resolveBenefits("  ")).rejects.toBeInstanceOf(EntitlementValidationError);
    expect(fake.statements.length).toBe(0);
  });
});

/* -------------------------------- qualifies ------------------------------- */

describe("qualifies: pure tier-rank predicate (Req 18.3, Property 14)", () => {
  it("is true when tier == minQualifyingTier", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    expect(await resolver.qualifies(CUST, "private_consultation")).toBe(true);
  });

  it("is true when tier is above minQualifyingTier", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    expect(await resolver.qualifies(CUST, "silver_gift")).toBe(true);
  });

  it("is false when tier is below minQualifyingTier", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 0, tier: "bronze" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    expect(await resolver.qualifies(CUST, "private_consultation")).toBe(false);
  });

  it("is independent of the benefit's active flag (a disabled VIP benefit still qualifies a VIP)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    expect(await resolver.qualifies(CUST, "invitation_only_experiences")).toBe(true);
  });

  it("throws for an unknown benefit key", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.qualifies(CUST, "nope")).rejects.toBeInstanceOf(BenefitNotFoundError);
  });

  it("does not write anything (read-only)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await resolver.qualifies(CUST, "private_consultation");
    expect(fake.statements.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
  });
});

/* ------------------------------ requestBenefit ---------------------------- */

describe("requestBenefit: qualifying + enabled records one row (Req 18.5, 7.8)", () => {
  it("records exactly one benefit_requests row for a qualifying Royal_VIP member", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const request = await resolver.requestBenefit(CUST, "private_consultation");

    expect(request.customerId).toBe(CUST);
    expect(request.benefitKey).toBe("private_consultation");
    expect(request.benefitId).toBe("b-vip");
    expect(request.status).toBe("requested");
    expect(request.id).toBeTruthy();

    // Exactly one row recorded, attributed to that member (Req 18.5).
    expect(fake.requests.length).toBe(1);
    expect(fake.requests[0]!.customer_id).toBe(CUST);
    expect(fake.requests[0]!.benefit_id).toBe("b-vip");
  });

  it("writes ONLY to benefit_requests and never to the ledger (off-ledger)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await resolver.requestBenefit(CUST, "private_consultation");

    const writes = fake.statements.filter((s) => /INSERT|UPDATE|DELETE/i.test(s));
    expect(writes.length).toBe(1);
    expect(writes.every((s) => /benefit_requests/i.test(s))).toBe(true);
    expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
  });
});

describe("requestBenefit: unqualified invocation (Req 18.6, Property 14)", () => {
  it("performs no state change and reports the required tier", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 0, tier: "bronze" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.requestBenefit(CUST, "private_consultation")).rejects.toMatchObject({
      name: "BenefitNotQualifiedError",
      requiredTier: "royal_vip",
      currentTier: "bronze",
      benefitKey: "private_consultation",
    });

    // No benefit_requests row was written on the deny path (Req 18.6).
    expect(fake.requests.length).toBe(0);
    expect(fake.statements.some((s) => /INSERT INTO benefit_requests/i.test(s))).toBe(false);
  });

  it("reports the exact required tier for a mid-tier gate", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 300, tier: "silver" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    // Silver customer cannot invoke the gold-gated benefit.
    const error = await resolver
      .requestBenefit(CUST, "gold_sample")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BenefitNotQualifiedError);
    expect((error as BenefitNotQualifiedError).requiredTier).toBe("gold");
    expect(fake.requests.length).toBe(0);
  });
});

describe("requestBenefit: qualifying invocation of a disabled benefit (Req 18.5)", () => {
  it("records nothing when the benefit is not enabled", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(
      resolver.requestBenefit(CUST, "invitation_only_experiences"),
    ).rejects.toBeInstanceOf(BenefitDisabledError);

    expect(fake.requests.length).toBe(0);
    expect(fake.statements.some((s) => /INSERT INTO benefit_requests/i.test(s))).toBe(false);
  });
});

describe("requestBenefit: not-found and failure handling", () => {
  it("throws BenefitNotFoundError for an unknown key and writes nothing", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.requestBenefit(CUST, "nope")).rejects.toBeInstanceOf(BenefitNotFoundError);
    expect(fake.requests.length).toBe(0);
  });

  it("throws CustomerNotFoundError when the customer does not exist and writes nothing", async () => {
    const fake = makeDb({ benefits: seedBenefits() });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(
      resolver.requestBenefit(CUST, "private_consultation"),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
    expect(fake.requests.length).toBe(0);
  });

  it("wraps a DB insert failure and leaves state unchanged", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: seedBenefits(),
      failInsert: true,
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.requestBenefit(CUST, "private_consultation")).rejects.toMatchObject({
      name: "BenefitRequestError",
    });
    expect(fake.requests.length).toBe(0);
  });
});

/* ------------------------- channel-gated entitlements --------------------- */

/** An app-exclusive VIP benefit (config.appExclusive === true) plus a normal one. */
function channelBenefits(): StoredBenefit[] {
  return [
    {
      id: "b-welcome",
      key: "welcome_note",
      name: "Welcome Note",
      min_qualifying_tier: "bronze",
      config: {},
      active: true,
    },
    {
      id: "b-app-vip",
      key: "app_early_access",
      name: "App Early Access",
      min_qualifying_tier: "royal_vip",
      config: { appExclusive: true },
      active: true,
    },
  ];
}

describe("channel-gated entitlements (task 21.1, Req 19.3/19.4, Property 15)", () => {
  it("derives appExclusive from config and grants an app-exclusive benefit only on the app channel", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    // On the app channel the VIP app-exclusive benefit resolves; on web it is filtered out.
    const appKeys = (await resolver.resolveBenefits(CUST, "app")).map((b) => b.key).sort();
    expect(appKeys).toEqual(["app_early_access", "welcome_note"]);

    const webKeys = (await resolver.resolveBenefits(CUST, "web")).map((b) => b.key).sort();
    expect(webKeys).toEqual(["welcome_note"]);
  });

  it("omitting the channel applies no channel filtering (additive, unchanged behaviour)", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const keys = (await resolver.resolveBenefits(CUST)).map((b) => b.key).sort();
    expect(keys).toEqual(["app_early_access", "welcome_note"]);
  });

  it("qualifies is true for an app-exclusive benefit only on the app channel", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    expect(await resolver.qualifies(CUST, "app_early_access", "app")).toBe(true);
    expect(await resolver.qualifies(CUST, "app_early_access", "web")).toBe(false);
    // No channel supplied → tier-only gate, unchanged.
    expect(await resolver.qualifies(CUST, "app_early_access")).toBe(true);
  });

  it("requestBenefit records an app-exclusive booking on the app channel", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const request = await resolver.requestBenefit(CUST, "app_early_access", "app");
    expect(request.benefitKey).toBe("app_early_access");
    expect(fake.requests.length).toBe(1);
  });

  it("requestBenefit denies an app-exclusive booking off the app channel with no state change", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 2000, tier: "royal_vip" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    await expect(resolver.requestBenefit(CUST, "app_early_access", "web")).rejects.toBeInstanceOf(
      BenefitChannelNotAllowedError,
    );
    // Nothing recorded on the deny path (Req 19.4, Property 15).
    expect(fake.requests.length).toBe(0);
    expect(fake.statements.some((s) => /INSERT INTO benefit_requests/i.test(s))).toBe(false);
  });

  it("a non-app-exclusive benefit is unaffected by channel", async () => {
    const fake = makeDb({
      customers: [{ id: CUST, lifetime_spend_gbp: 0, tier: "bronze" }],
      benefits: channelBenefits(),
    });
    const resolver = new DbEntitlementResolver(fake.db);

    const request = await resolver.requestBenefit(CUST, "welcome_note", "web");
    expect(request.benefitKey).toBe("welcome_note");
    expect(fake.requests.length).toBe(1);
  });
});

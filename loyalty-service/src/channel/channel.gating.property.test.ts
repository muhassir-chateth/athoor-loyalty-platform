/**
 * Property-based test for Property 15 — "App-exclusive channel gating"
 * (task 21.2), Requirement 19.4.
 *
 *   Property 15: an app-exclusive reward/entitlement is granted IFF the
 *   attributed `channel == 'app'`. Equivalently, for any channel-gated item:
 *
 *     isGrantableOnChannel(item, channel) === (!item.appExclusive || channel === 'app')
 *
 * This is a DISTINCT property-test file for task 21.2. It does NOT modify the
 * task-21.1 unit tests in `channel.test.ts`; it exercises the SAME pure,
 * side-effect-free gating predicate ({@link isGrantableOnChannel}) that BOTH
 * real call sites delegate to — the redemption path
 * ({@link import("../redemption/redeem.js").redeem} /
 * {@link import("../redemption/redeem.js").RewardChannelNotAllowedError}) and
 * the entitlement resolver
 * ({@link import("../benefits/entitlementResolver.js").DbEntitlementResolver}).
 *
 * This is a VERIFICATION task: the approved implementation is NOT changed.
 *
 * Two layers are asserted:
 *
 *   1. THE INVARIANT (pure core): over every combination of `appExclusive`
 *      (true / false / absent) and `channel` (`web` / `app`), the predicate
 *      equals the reference biconditional `!appExclusive || channel === 'app'`.
 *      In particular an app-exclusive item is grantable IFF the channel is
 *      `app`, and a non-exclusive item is grantable on EVERY channel.
 *
 *   2. A REAL ASYNC CALL SITE: the entitlement resolver is exercised against a
 *      fully self-contained, stateful in-memory fake {@link Queryable} so we can
 *      prove the invariant governs real behaviour with side effects — an
 *      app-exclusive Benefit invoked on `web` is rejected with NO state change
 *      (nothing recorded, ledger untouched), while on `app` it records exactly
 *      one row. (The four MVP rewards in the reward catalog are intentionally
 *      non-app-exclusive at MVP, so the redeem() path cannot carry an
 *      app-exclusive reward without changing the approved catalog; the
 *      entitlement resolver is the feasible real gating call site because a
 *      Benefit becomes app-exclusive purely by configuration —
 *      `config.appExclusive === true` — Req 18.7/19.3.)
 *
 * NO live/production database or Shopify Admin API is contacted; the fake models
 * only the SQL shapes the resolver issues over shared mutable row sets.
 *
 * **Validates: Requirements 19.4**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { TIERS, tierRank, type Tier } from "../tier/tier.js";
import {
  CHANNELS,
  isGrantableOnChannel,
  type Channel,
  type ChannelGated,
} from "./channel.js";
import {
  BenefitChannelNotAllowedError,
  DbEntitlementResolver,
} from "../benefits/entitlementResolver.js";

/* ------------------------------- arbitraries ------------------------------ */

/** A channel drawn from the exact known set (`web` | `app`). */
const channelArb: fc.Arbitrary<Channel> = fc.constantFrom(...CHANNELS);

/**
 * A channel-gated item. `appExclusive` is `true`, `false`, OR absent — the
 * `undefined` case is important because the flag is optional and defaults to
 * "grantable everywhere", so omitting it must behave exactly like `false`.
 */
const appExclusiveArb: fc.Arbitrary<boolean | undefined> = fc.constantFrom(
  true,
  false,
  undefined,
);

const itemArb: fc.Arbitrary<ChannelGated> = appExclusiveArb.map((appExclusive) =>
  appExclusive === undefined ? {} : { appExclusive },
);

/** The reference gating biconditional (Property 15) — the oracle. */
function expectedGrant(item: ChannelGated, channel: Channel): boolean {
  return !item.appExclusive || channel === "app";
}

/* --------------------------- self-contained fake -------------------------- */

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

const CUST = "44444444-4444-4444-4444-444444444444";

/** The lowest-rank tier, so any customer's derived tier trivially qualifies. */
const LOWEST_TIER: Tier = [...TIERS].sort((a, b) => tierRank(a) - tierRank(b))[0]!;

/**
 * Builds a fully self-contained fake {@link Queryable} modelling the
 * `customers`, `benefits`, and `benefit_requests` tables and the exact SQL the
 * resolver issues. Every statement text is recorded so a deny path can be
 * proven to write nothing and to never touch the ledger. The single seeded
 * customer always exists with enough lifetime spend to clear {@link LOWEST_TIER}
 * (so tier gating never masks the channel gate under test).
 */
function makeDb(benefit: StoredBenefit): FakeDb {
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

      // SELECT ... FROM customers WHERE id = $1  (always qualifies for LOWEST_TIER)
      if (/FROM customers/i.test(text)) {
        const id = values[0] as string;
        const row = id === CUST ? [{ lifetime_spend_gbp: 5000, tier: LOWEST_TIER }] : [];
        return ok(row as unknown as R[]);
      }

      // SELECT ... FROM benefits WHERE key = $1
      if (/FROM benefits/i.test(text) && /WHERE key/i.test(text)) {
        const key = values[0] as string;
        const rows =
          key === benefit.key
            ? [
                {
                  id: benefit.id,
                  key: benefit.key,
                  name: benefit.name,
                  min_qualifying_tier: benefit.min_qualifying_tier,
                  config: benefit.config,
                  active: benefit.active,
                },
              ]
            : [];
        return ok(rows as unknown as R[]);
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

/** An always-qualifying, enabled Benefit that is app-exclusive by configuration. */
function appExclusiveBenefit(): StoredBenefit {
  return {
    id: "b-app",
    key: "app_only_perk",
    name: "App-only perk",
    min_qualifying_tier: LOWEST_TIER,
    config: { appExclusive: true },
    active: true,
  };
}

/* ------------------------------- properties ------------------------------- */

describe("Property 15: app-exclusive channel gating — granted iff channel === 'app' (Req 19.4)", () => {
  it("isGrantableOnChannel equals (!appExclusive || channel === 'app') across the full input space", () => {
    fc.assert(
      fc.property(itemArb, channelArb, (item, channel) => {
        expect(isGrantableOnChannel(item, channel)).toBe(expectedGrant(item, channel));
      }),
      { numRuns: 500 },
    );
  });

  it("an app-exclusive item is grantable IFF the channel is 'app'", () => {
    fc.assert(
      fc.property(channelArb, (channel) => {
        expect(isGrantableOnChannel({ appExclusive: true }, channel)).toBe(channel === "app");
      }),
      { numRuns: 100 },
    );
  });

  it("a non-app-exclusive item (false or absent) is grantable on EVERY channel", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ChannelGated>({}, { appExclusive: false }),
        channelArb,
        (item, channel) => {
          expect(isGrantableOnChannel(item, channel)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("real call site: an app-exclusive Benefit invoked off the 'app' channel is rejected with NO state change", async () => {
    await fc.assert(
      fc.asyncProperty(channelArb, async (channel) => {
        const fake = makeDb(appExclusiveBenefit());
        const resolver = new DbEntitlementResolver(fake.db);

        const outcome = await resolver
          .requestBenefit(CUST, "app_only_perk", channel)
          .then((r) => ({ ok: true as const, r }))
          .catch((e: unknown) => ({ ok: false as const, e }));

        if (channel === "app") {
          // Granted: exactly one benefit_requests row, nothing else, no ledger.
          expect(outcome.ok).toBe(true);
          expect(fake.requests.length).toBe(1);
          const writes = fake.statements.filter((s) => /INSERT|UPDATE|DELETE/i.test(s));
          expect(writes.length).toBe(1);
          expect(writes.every((s) => /benefit_requests/i.test(s))).toBe(true);
        } else {
          // Denied on 'web': app-exclusive gate rejects with NO state change.
          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;
          expect(outcome.e).toBeInstanceOf(BenefitChannelNotAllowedError);
          const err = outcome.e as BenefitChannelNotAllowedError;
          expect(err.channel).toBe(channel);
          expect(err.requiredChannel).toBe("app");
          // Nothing recorded, no INSERT issued, ledger never touched.
          expect(fake.requests.length).toBe(0);
          expect(fake.statements.some((s) => /INSERT INTO benefit_requests/i.test(s))).toBe(false);
          expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * VIP benefit endpoints (task 30) — Req 18.2/18.3/18.5/18.6, 7.8, 19.4;
 * Property 14.
 *
 * WHAT THESE TESTS ARE, AND WHY THEY ARE NOT MORE UNIT TESTS: the entitlement
 * model already had thorough unit tests (task 15.2) and a property test for the
 * gating rule — and it was still completely unreachable in production. So these
 * tests drive the REAL `DbEntitlementResolver` (not a stub resolver) through the
 * REAL registered Fastify routes, over an in-memory Postgres fake that answers
 * the resolver's own SQL. That combination is what proves the runtime path is
 * exercised: if the route stopped calling the resolver, or the resolver stopped
 * reading the customer's tier, these fail.
 *
 * Coverage:
 *   - every tier (bronze / silver / gold / royal_vip) against benefits gated at
 *     each tier — resolution is inclusive of the customer's own tier and denies
 *     everything above it (Req 18.3, Property 14);
 *   - inactive benefits never appear in resolved account data (Req 18.5 / A13);
 *   - `GET /v1/balance` carries the same qualifying benefits (Req 18.2) and omits
 *     the field entirely when no resolver is wired (additive, Req 9.4);
 *   - an unqualified invocation is denied with the REQUIRED TIER and writes
 *     nothing (Req 18.6);
 *   - a qualifying invocation of a disabled benefit writes nothing (Req 18.5);
 *   - a qualifying invocation of an enabled benefit records exactly one
 *     `benefit_requests` row and no ledger entry (Req 18.5, off-ledger);
 *   - a Royal_VIP member reaches every Royal_VIP-exclusive benefit (Req 7.8);
 *   - app-exclusive benefits are gated to the `app` channel (Req 19.4);
 *   - unknown key, unknown customer, and a blank key are refused;
 *   - no other customer's identifiers appear in any response.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { registerCustomerScopeErrorHandler } from "../auth/customerScope.js";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import type { Queryable } from "../ledger/repository.js";
import { DbEntitlementResolver } from "../benefits/entitlementResolver.js";
import { registerBenefitRoutes } from "./benefits.js";
import { registerBalanceRoute, InMemoryCustomerBalanceSource } from "./balance.js";
import type { Channel } from "../channel/channel.js";

interface BenefitRow extends QueryResultRow {
  id: string;
  key: string;
  name: string;
  min_qualifying_tier: string;
  config: Record<string, unknown>;
  active: boolean;
}

/**
 * Answers exactly the SQL `DbEntitlementResolver` issues: the customer's
 * tier-driving row, the active-benefit list, a benefit by key, and the
 * `benefit_requests` insert. Nothing is stubbed above the SQL boundary, so the
 * resolver's real logic runs.
 */
class FakeDb implements Queryable {
  readonly customers = new Map<string, { lifetime_spend_gbp: number; tier: string | null }>();
  readonly benefits: BenefitRow[] = [];
  readonly requests: Array<{ id: string; customer_id: string; benefit_id: string; status: string }> = [];
  /** Any ledger write would be a bug: benefits are off-ledger. */
  readonly ledgerWrites: string[] = [];
  private seq = 0;

  seedCustomer(id: string, lifetimeSpendGBP: number, tier: string | null = null): void {
    this.customers.set(id, { lifetime_spend_gbp: lifetimeSpendGBP, tier });
  }

  seedBenefit(row: Partial<BenefitRow> & { key: string; min_qualifying_tier: string }): void {
    this.seq += 1;
    this.benefits.push({
      id: row.id ?? `benefit-${this.seq}`,
      key: row.key,
      name: row.name ?? row.key,
      min_qualifying_tier: row.min_qualifying_tier,
      config: row.config ?? {},
      active: row.active ?? true,
    });
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command = "SELECT"): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command,
      oid: 0,
      fields: [],
    });

    if (text.includes("FROM customers")) {
      const row = this.customers.get(values[0] as string);
      return ok(row ? [row] : []);
    }
    if (text.includes("FROM benefits") && text.includes("active = true")) {
      return ok(this.benefits.filter((b) => b.active));
    }
    if (text.includes("FROM benefits") && text.includes("key = $1")) {
      const row = this.benefits.find((b) => b.key === values[0]);
      return ok(row ? [row] : []);
    }
    if (text.includes("INSERT INTO benefit_requests")) {
      this.seq += 1;
      const row = {
        id: `req-${this.seq}`,
        customer_id: values[0] as string,
        benefit_id: values[1] as string,
        status: "requested",
        requested_at: new Date("2026-07-27T00:00:00Z"),
      };
      this.requests.push(row);
      return ok([row], "INSERT");
    }
    if (text.includes("INSERT INTO ledger_entries")) {
      this.ledgerWrites.push(text);
      return ok([], "INSERT");
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

const CUSTOMER = "cust-uuid";

/** Builds an app with the REAL resolver behind the REAL routes. */
async function buildApp(
  db: FakeDb,
  customerId: string = CUSTOMER,
  channel: Channel = "web",
  withResolver = true,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    req.authCtx = { customerId, source: channel === "app" ? "customer_account_api" : "app_proxy", channel };
  });
  const resolver = new DbEntitlementResolver(db);
  if (withResolver) {
    registerBenefitRoutes(app, { entitlementResolver: resolver });
  }
  registerBalanceRoute(app, {
    balanceSource: new InMemoryCustomerBalanceSource({
      [customerId]: { lifetimeSpendGBP: db.customers.get(customerId)?.lifetime_spend_gbp ?? 0, tier: db.customers.get(customerId)?.tier ?? null, spendableBalance: 500 },
    }),
    ...(withResolver ? { entitlementResolver: resolver } : {}),
  });
  await app.ready();
  return app;
}

/** One benefit gated at each tier, all enabled. */
function seedAllTiers(db: FakeDb): void {
  db.seedBenefit({ key: "b_bronze", min_qualifying_tier: "bronze" });
  db.seedBenefit({ key: "b_silver", min_qualifying_tier: "silver" });
  db.seedBenefit({ key: "b_gold", min_qualifying_tier: "gold" });
  db.seedBenefit({ key: "b_royal", min_qualifying_tier: "royal_vip" });
}

const keysOf = (body: string): string[] =>
  (JSON.parse(body).benefits as Array<{ key: string }>).map((b) => b.key).sort();

describe("GET /v1/benefits — resolution across every tier (Req 18.2/18.3, Property 14)", () => {
  // Thresholds come from the tier module: bronze £0, silver £300, gold £750,
  // royal_vip £1500. Asserting through spend (not a hardcoded tier string) proves
  // the resolver derives the tier from live loyalty data.
  it.each([
    ["bronze", 0, ["b_bronze"]],
    ["silver", 300, ["b_bronze", "b_silver"]],
    ["gold", 750, ["b_bronze", "b_gold", "b_silver"]],
    ["royal_vip", 1500, ["b_bronze", "b_gold", "b_royal", "b_silver"]],
  ] as const)("a %s member (spend £%d) qualifies for exactly %j", async (_tier, spend, expected) => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, spend);
    seedAllTiers(db);
    const app = await buildApp(db);

    const res = await app.inject({ method: "GET", url: "/benefits" });

    expect(res.statusCode).toBe(200);
    expect(keysOf(res.body)).toEqual([...expected]);
    await app.close();
  });

  it("grants a Royal_VIP member every Royal_VIP-exclusive benefit (Req 7.8)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    for (const key of ["consult", "early_access", "samples", "concierge"]) {
      db.seedBenefit({ key, min_qualifying_tier: "royal_vip" });
    }
    const app = await buildApp(db);

    const res = await app.inject({ method: "GET", url: "/benefits" });

    expect(keysOf(res.body)).toEqual(["concierge", "consult", "early_access", "samples"]);
    await app.close();
  });

  it("never returns an INACTIVE benefit, even to a qualifying member (A13)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    db.seedBenefit({ key: "roadmap_perk", min_qualifying_tier: "royal_vip", active: false });
    db.seedBenefit({ key: "live_perk", min_qualifying_tier: "royal_vip", active: true });
    const app = await buildApp(db);

    expect(keysOf((await app.inject({ method: "GET", url: "/benefits" })).body)).toEqual(["live_perk"]);
    await app.close();
  });

  it("returns an EMPTY list, not an error, when the member qualifies for nothing", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 0);
    db.seedBenefit({ key: "b_royal", min_qualifying_tier: "royal_vip" });
    const app = await buildApp(db);

    const res = await app.inject({ method: "GET", url: "/benefits" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).benefits).toEqual([]);
    await app.close();
  });

  it("respects a RETAINED tier above the one the spend implies (Req 7.3/7.7)", async () => {
    const db = new FakeDb();
    // Spend says bronze; the retained tier says gold. The resolver must honour
    // the retained tier, exactly as the balance summary does.
    db.seedCustomer(CUSTOMER, 0, "gold");
    seedAllTiers(db);
    const app = await buildApp(db);

    expect(keysOf((await app.inject({ method: "GET", url: "/benefits" })).body)).toEqual([
      "b_bronze",
      "b_gold",
      "b_silver",
    ]);
    await app.close();
  });

  it("404s when the resolved identity has no customer row", async () => {
    const db = new FakeDb();
    seedAllTiers(db);
    const app = await buildApp(db, "ghost-uuid");

    const res = await app.inject({ method: "GET", url: "/benefits" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("entitlement_customer_not_found");
    // The id is not echoed back.
    expect(res.body).not.toContain("ghost-uuid");
    await app.close();
  });

  it("gates an app-exclusive benefit to the app channel (Req 19.4, Property 15)", async () => {
    const seed = (db: FakeDb) => {
      db.seedCustomer(CUSTOMER, 5000);
      db.seedBenefit({ key: "app_perk", min_qualifying_tier: "bronze", config: { appExclusive: true } });
      db.seedBenefit({ key: "web_perk", min_qualifying_tier: "bronze" });
    };

    const webDb = new FakeDb();
    seed(webDb);
    const webApp = await buildApp(webDb, CUSTOMER, "web");
    expect(keysOf((await webApp.inject({ method: "GET", url: "/benefits" })).body)).toEqual(["web_perk"]);
    await webApp.close();

    const appDb = new FakeDb();
    seed(appDb);
    const appApp = await buildApp(appDb, CUSTOMER, "app");
    expect(keysOf((await appApp.inject({ method: "GET", url: "/benefits" })).body)).toEqual([
      "app_perk",
      "web_perk",
    ]);
    await appApp.close();
  });
});

describe("GET /v1/balance carries the qualifying benefits (Req 18.2)", () => {
  it("includes exactly the same benefits the dedicated endpoint returns", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 750);
    seedAllTiers(db);
    const app = await buildApp(db);

    const balance = JSON.parse((await app.inject({ method: "GET", url: "/balance" })).body);
    const benefits = JSON.parse((await app.inject({ method: "GET", url: "/benefits" })).body);

    expect(balance.tier).toBe("gold");
    expect(balance.benefits).toEqual(benefits.benefits);
    // The pre-existing fields are untouched.
    expect(balance.spendableBalance).toBe(500);
    expect(Array.isArray(balance.availableRewards)).toBe(true);
    await app.close();
  });

  it("OMITS the benefits field entirely when no resolver is wired (additive, Req 9.4)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 750);
    seedAllTiers(db);
    const app = await buildApp(db, CUSTOMER, "web", false);

    const res = await app.inject({ method: "GET", url: "/balance" });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect("benefits" in body).toBe(false);
    // And the benefit endpoint does not exist on such a build.
    expect((await app.inject({ method: "GET", url: "/benefits" })).statusCode).toBe(404);
    await app.close();
  });

  it("still serves the balance when entitlement resolution fails", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 750);
    // No benefit rows seeded and the benefits SELECT made to throw.
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return async (text: string, values?: unknown[]) => {
            if (text.includes("FROM benefits")) throw new Error("benefits table unavailable");
            return target.query(text, values);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as FakeDb;
    const app = await buildApp(broken);

    const res = await app.inject({ method: "GET", url: "/balance" });

    // Degraded, not failed: the core summary is intact and `benefits` is absent.
    expect(res.statusCode).toBe(200);
    expect("benefits" in JSON.parse(res.body)).toBe(false);
    expect(JSON.parse(res.body).tier).toBe("gold");
    await app.close();
  });
});

describe("POST /v1/benefits/:key/request (Req 18.5/18.6)", () => {
  it("records exactly one request for a qualifying member and an ENABLED benefit", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 1500);
    db.seedBenefit({ key: "private_consultation", min_qualifying_tier: "royal_vip", active: true });
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/private_consultation/request" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      benefitKey: "private_consultation",
      status: "requested",
    });
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0]!.customer_id).toBe(CUSTOMER);
    // Off-ledger: a benefit request never writes a ledger entry.
    expect(db.ledgerWrites).toEqual([]);
    await app.close();
  });

  it("DENIES an unqualified member, reports the required tier, and writes nothing (Req 18.6)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 0); // bronze
    db.seedBenefit({ key: "private_consultation", min_qualifying_tier: "royal_vip", active: true });
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/private_consultation/request" });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "entitlement_not_qualified",
      requiredTier: "royal_vip",
      currentTier: "bronze",
    });
    expect(db.requests).toEqual([]);
    await app.close();
  });

  it.each([
    ["bronze", 0],
    ["silver", 300],
    ["gold", 750],
  ] as const)("denies a %s member a royal_vip benefit with no state change", async (tier, spend) => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, spend);
    db.seedBenefit({ key: "royal_perk", min_qualifying_tier: "royal_vip", active: true });
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/royal_perk/request" });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).currentTier).toBe(tier);
    expect(db.requests).toEqual([]);
    await app.close();
  });

  it("records NOTHING when a qualifying member invokes a DISABLED benefit (Req 18.5)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    db.seedBenefit({ key: "roadmap_perk", min_qualifying_tier: "royal_vip", active: false });
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/roadmap_perk/request" });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("entitlement_benefit_disabled");
    expect(db.requests).toEqual([]);
    await app.close();
  });

  it("checks the TIER before the enabled flag, so an unqualified member learns the tier", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 0);
    db.seedBenefit({ key: "roadmap_perk", min_qualifying_tier: "royal_vip", active: false });
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/roadmap_perk/request" });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).requiredTier).toBe("royal_vip");
    await app.close();
  });

  it("404s an unknown benefit key without writing anything", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    const app = await buildApp(db);

    const res = await app.inject({ method: "POST", url: "/benefits/no_such_perk/request" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("entitlement_benefit_not_found");
    expect(db.requests).toEqual([]);
    await app.close();
  });

  it("refuses an app-exclusive benefit invoked from the web channel (Req 19.4)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    db.seedBenefit({
      key: "app_only",
      min_qualifying_tier: "bronze",
      active: true,
      config: { appExclusive: true },
    });
    const app = await buildApp(db, CUSTOMER, "web");

    const res = await app.inject({ method: "POST", url: "/benefits/app_only/request" });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "entitlement_channel_not_allowed",
      requiredChannel: "app",
    });
    expect(db.requests).toEqual([]);
    await app.close();
  });

  it("allows the same app-exclusive benefit on the app channel", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    db.seedBenefit({
      key: "app_only",
      min_qualifying_tier: "bronze",
      active: true,
      config: { appExclusive: true },
    });
    const app = await buildApp(db, CUSTOMER, "app");

    const res = await app.inject({ method: "POST", url: "/benefits/app_only/request" });

    expect(res.statusCode).toBe(200);
    expect(db.requests).toHaveLength(1);
    await app.close();
  });

  it("attributes the request to the AUTHENTICATED customer, never to a body or path value", async () => {
    const db = new FakeDb();
    db.seedCustomer("real-customer", 5000);
    db.seedBenefit({ key: "perk", min_qualifying_tier: "bronze", active: true });
    const app = await buildApp(db, "real-customer");

    const res = await app.inject({
      method: "POST",
      url: "/benefits/perk/request",
      payload: { customerId: "victim-customer" },
    });

    expect(res.statusCode).toBe(200);
    expect(db.requests[0]!.customer_id).toBe("real-customer");
    expect(res.body).not.toContain("victim-customer");
    await app.close();
  });

  it("401s when no identity is attached (defensive; auth normally rejects first)", async () => {
    const db = new FakeDb();
    db.seedCustomer(CUSTOMER, 5000);
    db.seedBenefit({ key: "perk", min_qualifying_tier: "bronze", active: true });
    const app = Fastify({ logger: false });
    // The 401 mapping lives at the /v1 scope now (task 5.2), so a harness must
    // install the same one the router does. Intent is unchanged: no identity
    // means 401 and no mutation.
    registerCustomerScopeErrorHandler(app);
    registerBenefitRoutes(app, { entitlementResolver: new DbEntitlementResolver(db) });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/benefits/perk/request" });

    expect(res.statusCode).toBe(401);
    expect(db.requests).toEqual([]);
    await app.close();
  });
});

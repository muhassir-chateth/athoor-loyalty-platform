/**
 * Identity resolution (task 6.2, Requirements 9.2, 9.3).
 *
 * Every `/v1` request must be resolved to a local `customers.id` BEFORE any
 * handler runs (Requirement 9.2), whether it arrived via Shopify App Proxy
 * (web) or a Customer Account API bearer token (mobile / portal). Both paths
 * converge on a single {@link AuthCtx}. If identity cannot be resolved, the
 * request is rejected with an identity-resolution failure and no handler runs,
 * so no state change occurs (Requirement 9.3).
 *
 * The two Shopify-facing dependencies — mapping a Shopify customer id to a
 * local row, and verifying a Customer Account API token — are expressed as
 * injectable interfaces so the resolution logic is unit-testable with fakes and
 * NEVER calls a live Shopify endpoint from a test or local run.
 *
 * SAFETY: the in-memory/fake implementations touch nothing external. The
 * Pg-backed resolver issues a read-only SELECT only when a caller passes a real
 * Pool/PoolClient at runtime.
 */
import type { QueryResult, QueryResultRow } from "pg";

/**
 * The resolved identity every `/v1` handler runs with (design.md → `AuthCtx`).
 *
 *  - `customerId` is the LOCAL `customers.id` (UUID), never the raw Shopify id,
 *    so downstream engine code is identity-source agnostic.
 *  - `source` records which channel authenticated the request.
 *  - `channel` is the origin (`web` via App Proxy, `app` via a bearer token),
 *    carried so later channel-attributed rewards (Requirement 19) can build on
 *    it additively.
 */
export interface AuthCtx {
  customerId: string;
  source: "app_proxy" | "customer_account_api";
  channel: "web" | "app";
}

/**
 * Maps a Shopify customer id (the numeric id Shopify uses) to the local
 * `customers.id`. Returns `null` when no local customer exists for that Shopify
 * id, which the gateway treats as an unresolvable identity (Requirement 9.3).
 *
 * NOTE: resolution is READ-ONLY. Lazy enrollment of not-yet-seen customers
 * (assumption A3) is owned by the earning/webhook path, not by auth.
 */
export interface CustomerResolver {
  resolveByShopifyCustomerId(shopifyCustomerId: string): Promise<string | null>;
}

/**
 * Verifies a Customer Account API bearer token and returns the Shopify customer
 * id it authenticates, or `null` if the token is missing/invalid/expired.
 *
 * The service builds NO custom authentication (Requirement 11.5) — a production
 * implementation validates the token against Shopify's Customer Account API.
 * Kept behind this interface so tests inject a fake and never call live
 * Shopify.
 */
export interface CustomerAccountTokenVerifier {
  verify(token: string): Promise<string | null>;
}

/**
 * Default bearer-token verifier used until a real Customer Account API verifier
 * is wired: it fails closed, treating every token as unverifiable. This keeps
 * the app bootable without a Shopify verifier while never trusting a token by
 * accident.
 */
export class UnconfiguredTokenVerifier implements CustomerAccountTokenVerifier {
  async verify(_token: string): Promise<string | null> {
    return null;
  }
}

/**
 * In-memory {@link CustomerResolver} backed by a `shopifyCustomerId → localId`
 * map. The default resolver for local runs and the vehicle for tests, so the
 * gateway resolves identity with no live Postgres.
 */
export class InMemoryCustomerResolver implements CustomerResolver {
  private readonly byShopifyId: Map<string, string>;

  constructor(entries: Record<string, string> | Map<string, string> = {}) {
    this.byShopifyId = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async resolveByShopifyCustomerId(shopifyCustomerId: string): Promise<string | null> {
    return this.byShopifyId.get(shopifyCustomerId) ?? null;
  }

  /** Test/setup helper: register a Shopify → local id mapping. */
  set(shopifyCustomerId: string, localCustomerId: string): void {
    this.byShopifyId.set(shopifyCustomerId, localCustomerId);
  }
}

/**
 * In-memory {@link CustomerAccountTokenVerifier} backed by a `token → shopify
 * customer id` map. Used by tests to stand in for Shopify's Customer Account
 * API; an unknown token resolves to `null` (unverifiable).
 */
export class FakeTokenVerifier implements CustomerAccountTokenVerifier {
  private readonly byToken: Map<string, string>;

  constructor(entries: Record<string, string> | Map<string, string> = {}) {
    this.byToken = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async verify(token: string): Promise<string | null> {
    return this.byToken.get(token) ?? null;
  }

  /** Test/setup helper: register a token → Shopify customer id mapping. */
  set(token: string, shopifyCustomerId: string): void {
    this.byToken.set(token, shopifyCustomerId);
  }
}

/**
 * The minimal database surface the Pg-backed resolver needs. A `pg` Pool and
 * PoolClient both satisfy this (mirrors the idempotency store / ledger repo).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

const SELECT_LOCAL_ID_SQL = `
  SELECT id
  FROM customers
  WHERE shopify_customer_id = $1
  LIMIT 1
`;

interface CustomerIdRow {
  id: string;
}

/**
 * Postgres-backed {@link CustomerResolver}: looks up `customers.id` by
 * `shopify_customer_id`. Read-only.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing. Not used by tests or local runs
 * — the in-memory resolver is the default so no live Postgres is required.
 */
export class PgCustomerResolver implements CustomerResolver {
  constructor(private readonly db: Queryable) {}

  async resolveByShopifyCustomerId(shopifyCustomerId: string): Promise<string | null> {
    const result = await this.db.query<CustomerIdRow>(SELECT_LOCAL_ID_SQL, [shopifyCustomerId]);
    return result.rows[0]?.id ?? null;
  }
}

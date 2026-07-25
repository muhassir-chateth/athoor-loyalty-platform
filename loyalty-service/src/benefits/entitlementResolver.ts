/**
 * Entitlement Resolver (task 15.2) — design.md "Component 6: Entitlement
 * Resolver" and Requirement 18 (VIP benefits framework).
 *
 * The resolver answers three questions about the configurable, tier-gated
 * Benefits seeded in the `benefits` table (task 15.1):
 *
 *   - {@link EntitlementResolver.resolveBenefits} — which *active* Benefits does
 *     a customer's current tier qualify for? These are the Benefits included in
 *     the customer's returned account data (Req 18.2).
 *   - {@link EntitlementResolver.qualifies} — is a customer entitled to a named
 *     Benefit, i.e. is `tier(c) >= benefit.minQualifyingTier`? This is the pure
 *     tier-gating predicate of Property 14 (Req 18.3, 18.6).
 *   - {@link EntitlementResolver.requestBenefit} — record a Benefit invocation
 *     (e.g. a private-consultation booking) as a `benefit_requests` row when the
 *     customer qualifies AND the Benefit is enabled (Req 18.5). An unqualified
 *     invocation performs NO state change and reports the required tier
 *     (Req 18.6). A Royal_VIP member therefore reaches every Royal_VIP-exclusive
 *     Benefit (Req 7.8).
 *
 * TIER GATING (Property 14 / Req 18.3): a Benefit is granted to a customer **iff**
 * the customer's current tier rank is at least the Benefit's `minQualifyingTier`
 * rank. Rank comparison is delegated to the tier module ({@link tierRank}), the
 * single source of truth for tier ordering — this module never hardcodes it.
 *
 * DERIVED TIER: the "current tier" is the customer's retained/derived tier,
 * computed from the persisted `customers` row exactly as the balance endpoint
 * does — {@link advanceTier}(row.tier, row.lifetime_spend_gbp) — so the resolver
 * and the balance summary can never disagree about a customer's tier.
 *
 * READ-ONLY EXCEPT FOR REQUESTS: `resolveBenefits` and `qualifies` mutate
 * nothing. Only `requestBenefit` writes, and it writes a **single** row to the
 * off-ledger `benefit_requests` table — never to `ledger_entries`, and it never
 * touches a customer's Balance or Spendable_Balance. It calls no Shopify Admin
 * API.
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * PoolClient), so a request can join a caller's transaction and every path is
 * unit-testable against an in-memory fake with no live database.
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only when a caller passes a real Pool/PoolClient at runtime; all logic is
 * unit-tested against an in-memory fake Queryable, so no live system is touched
 * during verification.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { advanceTier, tierRank, type Tier } from "../tier/tier.js";
import { isGrantableOnChannel, type Channel } from "../channel/channel.js";

/**
 * A configuration-driven, tier-gated entitlement (design.md `Benefit`). Shape
 * mirrors the `benefits` table row so a definition maps 1:1 to a seeded row.
 */
export interface Benefit {
  /** Stable machine key, unique across benefits (e.g. `private_consultation`). */
  key: string;
  /** Human-readable name shown in account/portal data. */
  name: string;
  /** Minimum tier a customer must hold for this Benefit to be granted (Req 18.3). */
  minQualifyingTier: Tier;
  /** Perk-specific configuration for future Benefit types (JSONB). */
  config: Record<string, unknown>;
  /** Whether the Benefit is currently switched on (Req 18.5). */
  active: boolean;
  /**
   * When `true`, this Benefit is app-exclusive: it is granted ONLY when the
   * request is attributed to the `app` Channel (Req 19.3/19.4, task 21.1).
   * Derived from `config.appExclusive === true`, so an app-exclusive entitlement
   * is added purely by configuration (no schema change — Req 18.7). ADDITIVE:
   * absent/`false` means grantable on every channel, so existing Benefits are
   * unaffected.
   */
  appExclusive: boolean;
}

/**
 * A recorded Benefit invocation (design.md `POST /v1/benefits/:key/request`
 * result). Mirrors the `benefit_requests` row created when a qualifying member
 * invokes an enabled Benefit (Req 18.5).
 */
export interface BenefitRequest {
  /** The `benefit_requests.id` of the recorded request. */
  id: string;
  /** The requesting customer's local `customers.id`. */
  customerId: string;
  /** The `benefits.id` the request is for. */
  benefitId: string;
  /** The Benefit's stable key, echoed for caller convenience. */
  benefitKey: string;
  /** Lifecycle status; a freshly recorded request is `requested`. */
  status: string;
  /** When the request was recorded. */
  requestedAt: Date;
}

/**
 * The resolver contract (design.md "Component 6: Entitlement Resolver").
 *
 * Every operation accepts an OPTIONAL originating {@link Channel} (task 21.1,
 * Req 19.3). When supplied, an app-exclusive Benefit (`config.appExclusive`) is
 * gated to the `app` channel exactly as app-exclusive rewards are (Property 15).
 * When omitted, no channel gating is applied, so existing callers/behaviour are
 * unchanged (additive, Req 19.7).
 */
export interface EntitlementResolver {
  /** Benefits the customer's current tier qualifies for (active only) (Req 18.2); channel-gated when a channel is given (Req 19.3). */
  resolveBenefits(customerId: string, channel?: Channel): Promise<Benefit[]>;
  /** True iff the customer's tier >= the Benefit's minQualifyingTier (Req 18.3, 18.6) and the channel is allowed (Req 19.4). */
  qualifies(customerId: string, benefitKey: string, channel?: Channel): Promise<boolean>;
  /** Record a Benefit invocation when qualified + enabled (Req 18.5); deny + report required tier otherwise (Req 18.6); deny an app-exclusive Benefit off the `app` channel (Req 19.4). */
  requestBenefit(customerId: string, benefitKey: string, channel?: Channel): Promise<BenefitRequest>;
}

/** Stable machine-readable error codes surfaced to callers. */
export const ENTITLEMENT_ERROR_CODES = {
  invalidCustomer: "entitlement_invalid_customer",
  invalidBenefitKey: "entitlement_invalid_benefit_key",
  customerNotFound: "entitlement_customer_not_found",
  benefitNotFound: "entitlement_benefit_not_found",
  notQualified: "entitlement_not_qualified",
  benefitDisabled: "entitlement_benefit_disabled",
  channelNotAllowed: "entitlement_channel_not_allowed",
  requestFailed: "entitlement_request_failed",
} as const;

/** Thrown when a caller supplies an empty/blank customer id or benefit key. */
export class EntitlementValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EntitlementValidationError";
    this.code = code;
  }
}

/** Thrown when the resolved customer has no `customers` row (fail closed). */
export class CustomerNotFoundError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.customerNotFound;
  readonly customerId: string;
  constructor(customerId: string) {
    super(`No loyalty customer exists for id ${customerId}.`);
    this.name = "CustomerNotFoundError";
    this.customerId = customerId;
  }
}

/** Thrown when no Benefit is configured for the requested key. */
export class BenefitNotFoundError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.benefitNotFound;
  readonly benefitKey: string;
  constructor(benefitKey: string) {
    super(`No Benefit is configured for key '${benefitKey}'.`);
    this.name = "BenefitNotFoundError";
    this.benefitKey = benefitKey;
  }
}

/**
 * Thrown by {@link DbEntitlementResolver.requestBenefit} when the customer's
 * tier does not qualify for the Benefit (Req 18.6). No state change is
 * performed; the required tier is carried on the error so callers can report it.
 */
export class BenefitNotQualifiedError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.notQualified;
  readonly benefitKey: string;
  /** The minimum tier the customer must hold to invoke this Benefit (Req 18.6). */
  readonly requiredTier: Tier;
  /** The customer's current tier at the time of the denied invocation. */
  readonly currentTier: Tier;
  constructor(benefitKey: string, requiredTier: Tier, currentTier: Tier) {
    super(
      `Tier '${currentTier}' does not qualify for Benefit '${benefitKey}'; ` +
        `tier '${requiredTier}' is required.`,
    );
    this.name = "BenefitNotQualifiedError";
    this.benefitKey = benefitKey;
    this.requiredTier = requiredTier;
    this.currentTier = currentTier;
  }
}

/**
 * Thrown when a qualifying customer invokes a Benefit that is not enabled
 * (`active = false`). No `benefit_requests` row is recorded — a booking can only
 * be recorded WHERE the Benefit is enabled (Req 18.5).
 */
export class BenefitDisabledError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.benefitDisabled;
  readonly benefitKey: string;
  constructor(benefitKey: string) {
    super(`Benefit '${benefitKey}' is not currently enabled.`);
    this.name = "BenefitDisabledError";
    this.benefitKey = benefitKey;
  }
}

/**
 * Thrown when an app-exclusive Benefit is invoked from a non-`app` channel
 * (Req 19.4, task 21.1). No `benefit_requests` row is recorded — an
 * app-exclusive entitlement is granted only on the `app` channel (Property 15).
 */
export class BenefitChannelNotAllowedError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.channelNotAllowed;
  readonly benefitKey: string;
  readonly channel: Channel;
  readonly requiredChannel: Channel = "app";
  constructor(benefitKey: string, channel: Channel) {
    super(
      `Benefit '${benefitKey}' is app-exclusive and can only be invoked on the 'app' ` +
        `channel; the attributed channel was '${channel}', so no request was recorded.`,
    );
    this.name = "BenefitChannelNotAllowedError";
    this.benefitKey = benefitKey;
    this.channel = channel;
  }
}

/** Thrown when recording a `benefit_requests` row fails; state is unchanged. */
export class BenefitRequestError extends Error {
  readonly code = ENTITLEMENT_ERROR_CODES.requestFailed;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BenefitRequestError";
    this.cause = cause;
  }
}

/* ----------------------------- SQL statements ----------------------------- */

/** The customer's tier-driving facts, exactly as the balance endpoint reads them. */
const SELECT_CUSTOMER_TIER_SQL = `
  SELECT lifetime_spend_gbp, tier
  FROM customers
  WHERE id = $1
  LIMIT 1
`;

/** All ACTIVE Benefit definitions, for tier-based resolution (Req 18.2). */
const SELECT_ACTIVE_BENEFITS_SQL = `
  SELECT key, name, min_qualifying_tier, config, active
  FROM benefits
  WHERE active = true
`;

/** A single Benefit definition by its unique key (active or not). */
const SELECT_BENEFIT_BY_KEY_SQL = `
  SELECT id, key, name, min_qualifying_tier, config, active
  FROM benefits
  WHERE key = $1
  LIMIT 1
`;

/** Records one `benefit_requests` row for a qualifying, enabled invocation. */
const INSERT_BENEFIT_REQUEST_SQL = `
  INSERT INTO benefit_requests (customer_id, benefit_id)
  VALUES ($1, $2)
  RETURNING id, customer_id, benefit_id, status, requested_at
`;

/* -------------------------------- DB rows --------------------------------- */

interface CustomerTierDbRow extends QueryResultRow {
  lifetime_spend_gbp: string | number | null;
  tier: string | null;
}

interface BenefitDbRow extends QueryResultRow {
  id?: string;
  key: string;
  name: string;
  min_qualifying_tier: string;
  config: Record<string, unknown> | string | null;
  active: boolean;
}

interface BenefitRequestDbRow extends QueryResultRow {
  id: string;
  customer_id: string;
  benefit_id: string;
  status: string;
  requested_at: Date;
}

/** Parses a NUMERIC/BIGINT column (`pg` returns NUMERIC as a string) to a finite number. */
function parseSpendColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Coerces the JSONB `config` column (object, JSON string, or null) to a plain object. */
function parseConfigColumn(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value;
}

/** Maps a `benefits` row to the public {@link Benefit} shape. */
function toBenefit(row: BenefitDbRow): Benefit {
  const config = parseConfigColumn(row.config);
  return {
    key: row.key,
    name: row.name,
    minQualifyingTier: row.min_qualifying_tier as Tier,
    config,
    active: row.active === true,
    // App-exclusivity is configuration-driven (Req 18.7): a Benefit is
    // app-exclusive iff its JSONB config carries `appExclusive: true` (task 21.1).
    appExclusive: config.appExclusive === true,
  };
}

function assertCustomerId(customerId: string): void {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new EntitlementValidationError(
      "An entitlement operation requires a customer id.",
      ENTITLEMENT_ERROR_CODES.invalidCustomer,
    );
  }
}

function assertBenefitKey(benefitKey: string): void {
  if (typeof benefitKey !== "string" || benefitKey.trim() === "") {
    throw new EntitlementValidationError(
      "An entitlement operation requires a benefit key.",
      ENTITLEMENT_ERROR_CODES.invalidBenefitKey,
    );
  }
}

/**
 * Postgres/`Queryable`-backed {@link EntitlementResolver}.
 *
 * All three operations delegate tier ordering to the tier module ({@link tierRank}),
 * so the gating rule is exactly Property 14: granted iff
 * `tierRank(current) >= tierRank(benefit.minQualifyingTier)`.
 */
export class DbEntitlementResolver implements EntitlementResolver {
  constructor(private readonly db: Queryable) {}

  /**
   * Loads the customer's current (retained/derived) tier from the `customers`
   * row, computed identically to the balance endpoint via {@link advanceTier}.
   *
   * @throws {@link CustomerNotFoundError} when no customer row exists.
   */
  private async loadCurrentTier(customerId: string): Promise<Tier> {
    const result = await this.db.query<CustomerTierDbRow>(SELECT_CUSTOMER_TIER_SQL, [customerId]);
    const row = result.rows[0];
    if (!row) {
      throw new CustomerNotFoundError(customerId);
    }
    return advanceTier(row.tier, parseSpendColumn(row.lifetime_spend_gbp));
  }

  /** Loads a single Benefit by key, or `null` when none is configured. */
  private async loadBenefitByKey(benefitKey: string): Promise<(Benefit & { id: string }) | null> {
    const result = await this.db.query<BenefitDbRow>(SELECT_BENEFIT_BY_KEY_SQL, [benefitKey]);
    const row = result.rows[0];
    if (!row || typeof row.id !== "string") {
      return null;
    }
    return { ...toBenefit(row), id: row.id };
  }

  /**
   * Returns every ACTIVE Benefit the customer's current tier qualifies for
   * (Req 18.2): those whose `minQualifyingTier` rank is at most the customer's
   * tier rank (Property 14). Read-only.
   *
   * When a `channel` is supplied (task 21.1, Req 19.3), an app-exclusive Benefit
   * is additionally gated to the `app` channel via {@link isGrantableOnChannel}
   * (Property 15). When omitted, no channel filtering is applied so existing
   * callers behave exactly as before (additive, Req 19.7).
   */
  async resolveBenefits(customerId: string, channel?: Channel): Promise<Benefit[]> {
    assertCustomerId(customerId);
    const currentTier = await this.loadCurrentTier(customerId);
    const currentRank = tierRank(currentTier);

    const result = await this.db.query<BenefitDbRow>(SELECT_ACTIVE_BENEFITS_SQL);
    return result.rows
      .map(toBenefit)
      .filter((benefit) => tierRank(benefit.minQualifyingTier) <= currentRank)
      .filter((benefit) => channel === undefined || isGrantableOnChannel(benefit, channel));
  }

  /**
   * True iff the customer's current tier qualifies for the named Benefit, i.e.
   * `tierRank(current) >= tierRank(benefit.minQualifyingTier)` (Property 14,
   * Req 18.3/18.6). Purely tier-gated — independent of the Benefit's `active`
   * flag. Read-only.
   *
   * @throws {@link BenefitNotFoundError} when no Benefit is configured for the key.
   * @throws {@link CustomerNotFoundError} when no customer row exists.
   */
  async qualifies(customerId: string, benefitKey: string, channel?: Channel): Promise<boolean> {
    assertCustomerId(customerId);
    assertBenefitKey(benefitKey);

    const benefit = await this.loadBenefitByKey(benefitKey);
    if (!benefit) {
      throw new BenefitNotFoundError(benefitKey);
    }
    // When a channel is attributed, an app-exclusive Benefit qualifies only on
    // the `app` channel (Req 19.4, Property 15) — regardless of tier.
    if (channel !== undefined && !isGrantableOnChannel(benefit, channel)) {
      return false;
    }
    const currentTier = await this.loadCurrentTier(customerId);
    return tierRank(currentTier) >= tierRank(benefit.minQualifyingTier);
  }

  /**
   * Records a Benefit invocation (e.g. a private-consultation booking) as a
   * single `benefit_requests` row when the customer qualifies AND the Benefit is
   * enabled (Req 18.5). A qualifying Royal_VIP member therefore reaches every
   * Royal_VIP-exclusive Benefit (Req 7.8).
   *
   * When the customer's tier does not qualify, NO state change is performed and
   * a {@link BenefitNotQualifiedError} carrying the required tier is thrown
   * (Req 18.6). When the customer qualifies but the Benefit is disabled, no row
   * is recorded and a {@link BenefitDisabledError} is thrown (Req 18.5).
   *
   * @throws {@link BenefitNotFoundError} when no Benefit is configured for the key.
   * @throws {@link CustomerNotFoundError} when no customer row exists.
   * @throws {@link BenefitNotQualifiedError} when the tier does not qualify (no state change).
   * @throws {@link BenefitDisabledError} when the Benefit is not enabled (no state change).
   * @throws {@link BenefitRequestError} when the insert fails (state unchanged).
   */
  async requestBenefit(
    customerId: string,
    benefitKey: string,
    channel?: Channel,
  ): Promise<BenefitRequest> {
    assertCustomerId(customerId);
    assertBenefitKey(benefitKey);

    const benefit = await this.loadBenefitByKey(benefitKey);
    if (!benefit) {
      throw new BenefitNotFoundError(benefitKey);
    }

    // Channel gate: when a channel is attributed, an app-exclusive Benefit can
    // only be invoked on the `app` channel (Req 19.4, Property 15). Denied with
    // NO state change — nothing is recorded (checked before the INSERT below).
    if (channel !== undefined && !isGrantableOnChannel(benefit, channel)) {
      throw new BenefitChannelNotAllowedError(benefitKey, channel);
    }

    // Tier gate FIRST so an unqualified invocation returns the required tier and
    // performs no state change (Req 18.6, Property 14) — the disabled check and
    // the INSERT below are never reached.
    const currentTier = await this.loadCurrentTier(customerId);
    if (tierRank(currentTier) < tierRank(benefit.minQualifyingTier)) {
      throw new BenefitNotQualifiedError(benefitKey, benefit.minQualifyingTier, currentTier);
    }

    // The customer qualifies; a booking is only recordable WHERE the Benefit is
    // enabled (Req 18.5). A disabled Benefit records nothing.
    if (!benefit.active) {
      throw new BenefitDisabledError(benefitKey);
    }

    let row: BenefitRequestDbRow | undefined;
    try {
      const result = await this.db.query<BenefitRequestDbRow>(INSERT_BENEFIT_REQUEST_SQL, [
        customerId,
        benefit.id,
      ]);
      row = result.rows[0];
    } catch (cause) {
      // A single INSERT is atomic: on failure nothing is persisted, so the
      // benefit-request state is unchanged and the operation is rejected.
      throw new BenefitRequestError(
        `Failed to record a benefit request for customer ${customerId} and benefit ` +
          `'${benefitKey}'; no request was recorded.`,
        cause,
      );
    }

    if (!row) {
      throw new BenefitRequestError(
        "Recording a benefit request returned no row; the request did not persist.",
      );
    }

    return {
      id: row.id,
      customerId: row.customer_id,
      benefitId: row.benefit_id,
      benefitKey: benefit.key,
      status: row.status,
      requestedAt: row.requested_at,
    };
  }
}

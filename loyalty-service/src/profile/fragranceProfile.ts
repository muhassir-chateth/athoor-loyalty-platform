/**
 * Fragrance Profile composition + Fragrance Journey Timeline (task 14.5).
 *
 * Part of the Profile / Preferences Service (design.md "Component 9"). This
 * module is the COMPOSITION layer that assembles a customer's
 * `Fragrance_Profile` and `Fragrance_Journey_Timeline` from the pieces built by
 * the earlier profile tasks, and backs the design's
 * `ProfileService.getFragranceProfile(customerId): Promise<FragranceProfile>`
 * and `ProfileService.getJourneyTimeline(customerId): Promise<JourneyMilestone[]>`
 * (surfaced over `GET /v1/profile` and `GET /v1/profile/journey`).
 *
 * WHAT THIS MODULE GUARANTEES (Requirement 17)
 * --------------------------------------------
 *   - 17.1 / 17.10: purchased fragrances are derived SOLELY from the customer's
 *     paid Shopify orders — reached only through the injected
 *     {@link FragranceProfileDataSource.getPurchasedFragrances}, which
 *     production wires to Shopify order data. This module never invents a
 *     purchase.
 *   - 17.8: the journey timeline returns the customer's milestones — first
 *     purchase, favourites added, and tier changes — ordered chronologically
 *     (oldest → newest).
 *   - 17.9: EMPTY, NOT ERROR. When the customer has no purchases, favourites,
 *     wishlist entries, recently-viewed products, suggestions, or milestones,
 *     each affected category resolves to an empty array; composing a profile
 *     never throws for an empty customer.
 *   - 17.10: product/order data is sourced from Shopify and preference data
 *     (favourites, wishlist, recently-viewed) from the Loyalty_Service, and only
 *     the REQUESTING customer's data is returned — every read is keyed on the
 *     single resolved `customerId` and no other customer's id is ever consulted.
 *
 * OFF-LEDGER (Req 17.3 / Property 13): composing a profile is a READ-ONLY
 * assembly of behavioural/preference data plus Shopify order data. It never
 * reads or writes `ledger_entries`, `point_lots`, or any balance-bearing table,
 * so it can never change a customer's Balance or Spendable_Balance.
 *
 * INJECTABLE DATA SOURCE (no live Shopify/DB in tests): all data is reached
 * through the {@link FragranceProfileDataSource} interface. Production wires
 * {@link PgFragranceProfileDataSource} (Postgres preferences + an injected
 * Shopify purchase/suggestion source); tests inject
 * {@link InMemoryFragranceProfileDataSource} so NO live Shopify or Postgres is
 * touched during verification. The composition itself is pure orchestration.
 *
 * SAFETY: defining this module touches no live/production system. Any I/O
 * happens only via the data source a caller injects at runtime.
 */

/* ------------------------------- domain types ------------------------------ */

/**
 * A fragrance the customer has purchased, derived SOLELY from that customer's
 * paid Shopify orders (Req 17.1 / 17.10). Timestamps are ISO 8601 strings (or
 * null when the source cannot supply them). `purchaseCount` is the number of
 * paid line occurrences the source attributes to this product.
 */
export interface PurchasedFragrance {
  /** Shopify product id of the purchased fragrance. */
  productId: string;
  /** Product title from Shopify, when available. */
  title: string | null;
  /** ISO 8601 timestamp of the earliest paid purchase of this product, if known. */
  firstPurchasedAt: string | null;
  /** ISO 8601 timestamp of the most recent paid purchase of this product, if known. */
  lastPurchasedAt: string | null;
  /** How many times this product appears across the customer's paid orders. */
  purchaseCount: number;
}

/** A favourite record with the timestamp it was added (drives `favourite_added` milestones). */
export interface FavouriteRecord {
  /** Shopify product id marked as a favourite (Req 17.2). */
  productId: string;
  /** ISO 8601 timestamp the favourite was added, if known. */
  addedAt: string | null;
}

/** A recently-viewed product within the A10 retention window, most-recent-first. */
export interface RecentlyViewedRecord {
  /** Shopify product id viewed. */
  productId: string;
  /** ISO 8601 timestamp of the (most recent) view. */
  viewedAt: string;
}

/** A tier change (drives `tier_change` milestones), from `tier_change_history`. */
export interface TierChangeRecord {
  /** The tier held before the change, or null for the initial tier assignment. */
  fromTier: string | null;
  /** The tier the customer moved to. */
  toTier: string;
  /** ISO 8601 timestamp of the change. */
  at: string;
  /** Why the tier changed (e.g. "order completion"). */
  reason: string;
}

/** The kinds of milestone that appear on the Fragrance_Journey_Timeline (Req 17.8). */
export type JourneyMilestoneType = "first_purchase" | "favourite_added" | "tier_change";

/**
 * A single chronological milestone on the customer's Fragrance_Journey_Timeline
 * (design.md → `JourneyMilestone`; Req 17.8). `at` is an ISO 8601 timestamp; the
 * remaining fields are populated per {@link JourneyMilestoneType}:
 *   - `first_purchase` / `favourite_added` carry `productId`;
 *   - `tier_change` carries `fromTier` + `toTier`.
 */
export interface JourneyMilestone {
  /** The milestone kind (Req 17.8). */
  type: JourneyMilestoneType;
  /** When the milestone occurred, as an ISO 8601 timestamp. */
  at: string;
  /** The product involved (first purchase / favourite added), else null. */
  productId: string | null;
  /** The prior tier for a `tier_change`, else null. */
  fromTier: string | null;
  /** The new tier for a `tier_change`, else null. */
  toTier: string | null;
  /** A human-readable description of the milestone. */
  description: string;
}

/**
 * The full Fragrance_Profile response (design.md → `FragranceProfile`;
 * Requirement 17). Every collection is present; an empty category is an empty
 * array, never absent and never an error (Req 17.9).
 */
export interface FragranceProfile {
  /** The requesting customer's local id — only this customer's data is returned (Req 17.10). */
  customerId: string;
  /** Purchased fragrances derived solely from the customer's paid Shopify orders (Req 17.1). */
  purchasedFragrances: PurchasedFragrance[];
  /** Product ids the customer has marked as favourites (Req 17.2). */
  favourites: string[];
  /** Account-level wishlist product ids (Req 17.4). */
  wishlist: string[];
  /** Recently-viewed products within the retention window, most-recent-first (Req 17.5). */
  recentlyViewed: RecentlyViewedRecord[];
  /** Suggested fragrances (rules-based, purchased excluded) (Req 17.6). */
  suggestions: string[];
  /** The chronological Fragrance_Journey_Timeline (Req 17.8). */
  journey: JourneyMilestone[];
}

/**
 * The injectable boundary to every data source the Fragrance_Profile needs.
 * Product/order data comes from Shopify; preference data from the
 * Loyalty_Service (Req 17.10). The composition depends only on this interface,
 * so tests inject a fake and no live Shopify/Postgres is called during
 * verification.
 *
 * Every method takes ONLY the requesting customer's id, so the composition can
 * never surface another customer's data (Req 17.10).
 */
export interface FragranceProfileDataSource {
  /** Purchased fragrances from the customer's paid Shopify orders (Req 17.1). */
  getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]>;
  /** The customer's favourites with added-at timestamps (Req 17.2). */
  getFavourites(customerId: string): Promise<readonly FavouriteRecord[]>;
  /** The customer's account-level wishlist product ids (Req 17.4). */
  getWishlist(customerId: string): Promise<readonly string[]>;
  /** The customer's recently-viewed products within the retention window (Req 17.5). */
  getRecentlyViewed(customerId: string): Promise<readonly RecentlyViewedRecord[]>;
  /** Rules-based suggestions with already-purchased excluded (Req 17.6). */
  getSuggestions(customerId: string): Promise<readonly string[]>;
  /** The customer's tier changes for the journey timeline (Req 17.8). */
  getTierChanges(customerId: string): Promise<readonly TierChangeRecord[]>;
}

/* --------------------------------- errors --------------------------------- */

/** Stable machine-readable error codes surfaced to callers. */
export const FRAGRANCE_PROFILE_ERROR_CODES = {
  invalidInput: "fragrance_profile_invalid_input",
} as const;

/**
 * Thrown when a caller supplies an invalid customer id. This is the ONLY
 * condition that rejects a profile read; an empty-but-valid customer yields an
 * empty profile, never an error (Req 17.9).
 */
export class InvalidFragranceProfileInputError extends Error {
  readonly code = FRAGRANCE_PROFILE_ERROR_CODES.invalidInput;
  constructor(message: string) {
    super(message);
    this.name = "InvalidFragranceProfileInputError";
  }
}

/* -------------------------------- helpers --------------------------------- */

/** Validates a local `customers.id` (the only rejectable input, Req 17.9). */
function requireCustomerId(customerId: string): string {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new InvalidFragranceProfileInputError("customerId must be a non-empty string.");
  }
  return customerId;
}

/** Parses an ISO timestamp to epoch ms, or null when absent/unparseable. */
function toEpochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.trim() === "") {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/* ---------------------------- journey building ---------------------------- */

/**
 * Builds the chronological Fragrance_Journey_Timeline from the customer's
 * purchases, favourites, and tier changes (Req 17.8). Pure and deterministic.
 *
 * Milestones:
 *   - `first_purchase`: a SINGLE milestone at the earliest dated purchase across
 *     all purchased fragrances (the customer's first purchase overall). Omitted
 *     when no purchase carries a timestamp (nothing to place chronologically).
 *   - `favourite_added`: one per favourite that carries an `addedAt`.
 *   - `tier_change`: one per tier change.
 *
 * The result is sorted ascending by timestamp (oldest first). Ties are broken
 * deterministically by milestone type then product/tier, so the ordering is
 * stable across calls and across identity sources.
 */
export function buildJourneyTimeline(
  purchases: readonly PurchasedFragrance[],
  favourites: readonly FavouriteRecord[],
  tierChanges: readonly TierChangeRecord[],
): JourneyMilestone[] {
  const milestones: Array<JourneyMilestone & { sortMs: number }> = [];

  // (1) First purchase — a single milestone at the earliest dated purchase.
  let firstProductId: string | null = null;
  let firstMs: number | null = null;
  for (const p of purchases) {
    const ms = toEpochMs(p.firstPurchasedAt);
    if (ms === null) {
      continue;
    }
    if (firstMs === null || ms < firstMs) {
      firstMs = ms;
      firstProductId = p.productId;
    }
  }
  if (firstMs !== null && firstProductId !== null) {
    milestones.push({
      type: "first_purchase",
      at: new Date(firstMs).toISOString(),
      productId: firstProductId,
      fromTier: null,
      toTier: null,
      description: "First fragrance purchase",
      sortMs: firstMs,
    });
  }

  // (2) Favourites added — one per favourite with a known added-at.
  for (const f of favourites) {
    const ms = toEpochMs(f.addedAt);
    if (ms === null) {
      continue;
    }
    milestones.push({
      type: "favourite_added",
      at: new Date(ms).toISOString(),
      productId: f.productId,
      fromTier: null,
      toTier: null,
      description: "Added a fragrance to favourites",
      sortMs: ms,
    });
  }

  // (3) Tier changes — one per change.
  for (const t of tierChanges) {
    const ms = toEpochMs(t.at);
    if (ms === null) {
      continue;
    }
    milestones.push({
      type: "tier_change",
      at: new Date(ms).toISOString(),
      productId: null,
      fromTier: t.fromTier ?? null,
      toTier: t.toTier,
      description:
        t.fromTier != null
          ? `Tier changed from ${t.fromTier} to ${t.toTier}`
          : `Reached ${t.toTier} tier`,
      sortMs: ms,
    });
  }

  // Chronological ascending; deterministic tie-breakers (Req 17.8).
  const typeRank: Record<JourneyMilestoneType, number> = {
    first_purchase: 0,
    tier_change: 1,
    favourite_added: 2,
  };
  milestones.sort((a, b) => {
    if (a.sortMs !== b.sortMs) {
      return a.sortMs - b.sortMs;
    }
    if (typeRank[a.type] !== typeRank[b.type]) {
      return typeRank[a.type] - typeRank[b.type];
    }
    const aKey = a.productId ?? a.toTier ?? "";
    const bKey = b.productId ?? b.toTier ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  // Strip the internal sort key from the public shape.
  return milestones.map(({ sortMs: _sortMs, ...m }) => m);
}

/* ------------------------------ the service ------------------------------- */

/**
 * Composes the Fragrance_Profile and Fragrance_Journey_Timeline for a customer
 * (design `ProfileService.getFragranceProfile` / `getJourneyTimeline`).
 *
 * All data is pulled from the injected {@link FragranceProfileDataSource}, keyed
 * ONLY on the requesting customer's id (Req 17.10). Every category defaults to
 * an empty array, so a customer with no data gets an empty — never erroring —
 * profile (Req 17.9). The single rejectable condition is an invalid customer id.
 */
export class FragranceProfileService {
  constructor(private readonly dataSource: FragranceProfileDataSource) {}

  /**
   * Returns the full Fragrance_Profile for the requesting customer (Req 17.1,
   * 17.2, 17.4, 17.5, 17.6, 17.8, 17.9, 17.10). Reads are performed in parallel
   * and every empty category resolves to `[]`.
   *
   * @param customerId the resolved local `customers.id` (only this customer's data).
   * @throws {@link InvalidFragranceProfileInputError} when `customerId` is empty/blank.
   */
  async getFragranceProfile(customerId: string): Promise<FragranceProfile> {
    const cid = requireCustomerId(customerId);

    const [purchases, favourites, wishlist, recentlyViewed, suggestions, tierChanges] =
      await Promise.all([
        this.dataSource.getPurchasedFragrances(cid),
        this.dataSource.getFavourites(cid),
        this.dataSource.getWishlist(cid),
        this.dataSource.getRecentlyViewed(cid),
        this.dataSource.getSuggestions(cid),
        this.dataSource.getTierChanges(cid),
      ]);

    return {
      customerId: cid,
      purchasedFragrances: [...purchases],
      favourites: favourites.map((f) => f.productId),
      wishlist: [...wishlist],
      recentlyViewed: [...recentlyViewed],
      suggestions: [...suggestions],
      journey: buildJourneyTimeline(purchases, favourites, tierChanges),
    };
  }

  /**
   * Returns ONLY the chronological Fragrance_Journey_Timeline for the requesting
   * customer (Req 17.8, 17.9). Reads just the purchases, favourites, and tier
   * changes needed to build milestones; an empty history yields `[]`.
   *
   * @param customerId the resolved local `customers.id`.
   * @throws {@link InvalidFragranceProfileInputError} when `customerId` is empty/blank.
   */
  async getJourneyTimeline(customerId: string): Promise<JourneyMilestone[]> {
    const cid = requireCustomerId(customerId);

    const [purchases, favourites, tierChanges] = await Promise.all([
      this.dataSource.getPurchasedFragrances(cid),
      this.dataSource.getFavourites(cid),
      this.dataSource.getTierChanges(cid),
    ]);

    return buildJourneyTimeline(purchases, favourites, tierChanges);
  }
}

/* ---------------------- in-memory data source (default) ------------------- */

/** Seed data for {@link InMemoryFragranceProfileDataSource}, keyed by customer id. */
export interface InMemoryFragranceProfileSeed {
  purchasedFragrances?: Record<string, PurchasedFragrance[]>;
  favourites?: Record<string, FavouriteRecord[]>;
  wishlist?: Record<string, string[]>;
  recentlyViewed?: Record<string, RecentlyViewedRecord[]>;
  suggestions?: Record<string, string[]>;
  tierChanges?: Record<string, TierChangeRecord[]>;
}

/**
 * In-memory {@link FragranceProfileDataSource} backed by per-customer maps. The
 * default source for local runs and the vehicle for tests, so `GET /v1/profile`
 * boots without live Shopify or Postgres. An unknown customer resolves to empty
 * arrays across the board (Req 17.9 — empty, not error).
 */
export class InMemoryFragranceProfileDataSource implements FragranceProfileDataSource {
  private readonly seed: Required<InMemoryFragranceProfileSeed>;

  constructor(seed: InMemoryFragranceProfileSeed = {}) {
    this.seed = {
      purchasedFragrances: seed.purchasedFragrances ?? {},
      favourites: seed.favourites ?? {},
      wishlist: seed.wishlist ?? {},
      recentlyViewed: seed.recentlyViewed ?? {},
      suggestions: seed.suggestions ?? {},
      tierChanges: seed.tierChanges ?? {},
    };
  }

  async getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]> {
    return this.seed.purchasedFragrances[customerId] ?? [];
  }

  async getFavourites(customerId: string): Promise<readonly FavouriteRecord[]> {
    return this.seed.favourites[customerId] ?? [];
  }

  async getWishlist(customerId: string): Promise<readonly string[]> {
    return this.seed.wishlist[customerId] ?? [];
  }

  async getRecentlyViewed(customerId: string): Promise<readonly RecentlyViewedRecord[]> {
    return this.seed.recentlyViewed[customerId] ?? [];
  }

  async getSuggestions(customerId: string): Promise<readonly string[]> {
    return this.seed.suggestions[customerId] ?? [];
  }

  async getTierChanges(customerId: string): Promise<readonly TierChangeRecord[]> {
    return this.seed.tierChanges[customerId] ?? [];
  }
}

/* -------------------- Postgres-backed data source (prod) ------------------ */

import type { QueryResult, QueryResultRow } from "pg";
import {
  getSuggestions,
  type SuggestionDataSource,
  type SuggestionEngine,
} from "./suggestions.js";

/** Minimal DB surface (a `pg` Pool or PoolClient satisfies it). */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Number of days recently-viewed entries are retained (A10). Mirrors the recently-viewed store default. */
const RETENTION_DAYS_DEFAULT = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The injectable boundary to Shopify ORDER data (Req 17.1 / 17.10). Production
 * wires an implementation backed by the customer's paid Shopify orders; there
 * is no live Shopify client in this module, so callers supply one. When none is
 * given, {@link EmptyShopifyFragranceSource} is used and purchased fragrances
 * resolve to empty (Req 17.9) until a real source is wired — the service still
 * boots and serves preference data.
 */
export interface ShopifyFragranceSource {
  /** Purchased fragrances from the customer's paid Shopify orders (Req 17.1). */
  getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]>;
}

/** Fail-safe Shopify source: no purchases (Req 17.9 — empty, not error). */
export class EmptyShopifyFragranceSource implements ShopifyFragranceSource {
  async getPurchasedFragrances(): Promise<readonly PurchasedFragrance[]> {
    return [];
  }
}

const SELECT_FAVOURITES_SQL = `
  SELECT shopify_product_id::text AS product_id, created_at
  FROM customer_favourites
  WHERE customer_id = $1
  ORDER BY created_at ASC, shopify_product_id ASC
`;

const SELECT_WISHLIST_SQL = `
  SELECT shopify_product_id::text AS product_id
  FROM customer_wishlist
  WHERE customer_id = $1
  ORDER BY shopify_product_id ASC
`;

const SELECT_RECENTLY_VIEWED_SQL = `
  SELECT shopify_product_id::text AS product_id, viewed_at
  FROM customer_recently_viewed
  WHERE customer_id = $1
    AND viewed_at > $2
  ORDER BY viewed_at DESC, shopify_product_id DESC
`;

const SELECT_TIER_CHANGES_SQL = `
  SELECT from_tier, to_tier, reason, created_at
  FROM tier_change_history
  WHERE customer_id = $1
  ORDER BY created_at ASC
`;

/** Options for {@link PgFragranceProfileDataSource}. */
export interface PgFragranceProfileOptions {
  /** Source of purchased fragrances (Shopify orders); defaults to {@link EmptyShopifyFragranceSource}. */
  shopify?: ShopifyFragranceSource;
  /** Suggestion engine to rank suggestions; defaults inside {@link getSuggestions}. */
  suggestionEngine?: SuggestionEngine;
  /** Recently-viewed retention window in whole days (A10 default 90). */
  retentionDays?: number;
  /** Clock for the retention cutoff (default `() => new Date()`). */
  now?: () => Date;
}

/**
 * Postgres-backed {@link FragranceProfileDataSource}.
 *
 * Preference data (favourites, wishlist, recently-viewed, tier changes) is read
 * READ-ONLY from the Profile/Preferences tables (task 14.1) — never the ledger
 * (Req 17.3). Product/order data (purchased fragrances) is sourced from the
 * injected {@link ShopifyFragranceSource} (Req 17.1 / 17.10). Suggestions reuse
 * the task-14.4 {@link getSuggestions} engine, fed the customer's purchase
 * history (Shopify) + view history (recently-viewed) so already-purchased
 * fragrances are excluded (Req 17.6).
 *
 * Every query is keyed on the single resolved `customerId`, so only the
 * requesting customer's data is ever read (Req 17.10).
 *
 * SAFETY: issues read-only SQL only when a caller passes a real Pool/PoolClient
 * at runtime; construction alone touches nothing.
 */
export class PgFragranceProfileDataSource implements FragranceProfileDataSource {
  private readonly db: Queryable;
  private readonly shopify: ShopifyFragranceSource;
  private readonly suggestionEngine?: SuggestionEngine;
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(db: Queryable, options: PgFragranceProfileOptions = {}) {
    this.db = db;
    this.shopify = options.shopify ?? new EmptyShopifyFragranceSource();
    this.suggestionEngine = options.suggestionEngine;
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS_DEFAULT;
    this.now = options.now ?? (() => new Date());
  }

  async getPurchasedFragrances(customerId: string): Promise<readonly PurchasedFragrance[]> {
    return this.shopify.getPurchasedFragrances(customerId);
  }

  async getFavourites(customerId: string): Promise<readonly FavouriteRecord[]> {
    const result = await this.db.query<{ product_id: string; created_at: Date }>(
      SELECT_FAVOURITES_SQL,
      [customerId],
    );
    return result.rows.map((row) => ({
      productId: row.product_id,
      addedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }

  async getWishlist(customerId: string): Promise<readonly string[]> {
    const result = await this.db.query<{ product_id: string }>(SELECT_WISHLIST_SQL, [customerId]);
    return result.rows.map((row) => row.product_id);
  }

  async getRecentlyViewed(customerId: string): Promise<readonly RecentlyViewedRecord[]> {
    const cutoff = new Date(this.now().getTime() - this.retentionDays * MS_PER_DAY);
    const result = await this.db.query<{ product_id: string; viewed_at: Date }>(
      SELECT_RECENTLY_VIEWED_SQL,
      [customerId, cutoff],
    );
    return result.rows.map((row) => ({
      productId: row.product_id,
      viewedAt: row.viewed_at instanceof Date ? row.viewed_at.toISOString() : String(row.viewed_at),
    }));
  }

  async getSuggestions(customerId: string): Promise<readonly string[]> {
    // Adapt Shopify purchases + Pg recently-viewed into the suggestion engine's
    // stable input, so already-purchased fragrances are excluded (Req 17.6).
    const suggestionSource: SuggestionDataSource = {
      getPurchaseHistory: async (cid) => {
        const purchases = await this.shopify.getPurchasedFragrances(cid);
        return purchases.map((p) => ({
          productId: p.productId,
          purchasedAt: p.firstPurchasedAt ? new Date(p.firstPurchasedAt) : undefined,
        }));
      },
      getViewHistory: async (cid) => {
        const views = await this.getRecentlyViewed(cid);
        return views.map((v) => ({ productId: v.productId, viewedAt: new Date(v.viewedAt) }));
      },
    };
    return this.suggestionEngine
      ? getSuggestions(customerId, suggestionSource, this.suggestionEngine)
      : getSuggestions(customerId, suggestionSource);
  }

  async getTierChanges(customerId: string): Promise<readonly TierChangeRecord[]> {
    const result = await this.db.query<{
      from_tier: string | null;
      to_tier: string;
      reason: string;
      created_at: Date;
    }>(SELECT_TIER_CHANGES_SQL, [customerId]);
    return result.rows.map((row) => ({
      fromTier: row.from_tier,
      toTier: row.to_tier,
      reason: row.reason,
      at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }
}

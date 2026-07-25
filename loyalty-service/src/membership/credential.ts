/**
 * Membership-Credential service (task 19.2, Requirements 19.5 & 19.6).
 *
 * MOBILE READINESS (Requirement 19). This module issues and verifies a
 * verifiable, SIGNED member identifier for the Digital Membership Card and
 * QR-based identification, and exposes the member id + tier a future mobile
 * wallet pass needs (design.md → "Component 8: Membership-Credential Service").
 * It backs the additive `/v1` routes `GET /v1/membership-card` (issue) and
 * `GET /v1/membership-card/verify` (verify) — see `routes/membershipCard.ts`.
 *
 * Two capabilities live here, mirroring the design's interface:
 *
 *   1. {@link MembershipCredentialService.issueCredential} — given a resolved
 *      local `customers.id`, mint a {@link MembershipCredential}: an OPAQUE,
 *      NON-PII-bearing `memberId`, the customer's current `tier`, an HMAC
 *      `signature` binding the two, and a compact `qrPayload` a QR encodes
 *      (Req 19.5/19.6).
 *
 *   2. {@link MembershipCredentialService.verifyCredential} — given a presented
 *      `signedMemberId` (the `qrPayload`), confirm it was issued by us and
 *      return ONLY `{ valid, tier? }` (Req 19.5). It NEVER returns the
 *      `memberId`, the local/Shopify customer id, or any other customer's data.
 *
 * KEY (Req 19.5, design "Secrets management"): a single DEDICATED signing key
 * (config `membership.signingKey`) is used — never the Admin token, webhook
 * secret, or App Proxy secret. The key both derives the opaque member id and
 * signs the credential. When the key is absent the service is UNAVAILABLE and
 * every operation throws {@link MembershipKeyUnavailableError}, so the routes
 * fail closed rather than issuing/accepting unsigned credentials.
 *
 * OPACITY / NON-PII (Req 19.5): `memberId = HMAC(key, "athoor:member:" + id)`
 * (base64url). It is deterministic per customer (stable for a wallet pass),
 * carries NO personal data, and is not reversible to the customer id without
 * the key.
 *
 * SELF-CONTAINED VERIFICATION: the credential is verifiable from its signature
 * alone — verification recomputes the HMAC over `memberId + tier` and compares
 * it in CONSTANT TIME ({@link import("node:crypto").timingSafeEqual}). No
 * database or ledger lookup happens on verify (design: "Signing/verification
 * only — no ledger interaction"), so verification cannot leak any other
 * customer's data.
 *
 * SAFETY: this module performs pure, local crypto only — no network call, no
 * live system, no ledger read/write. The tier source it depends on for ISSUING
 * is injectable and defaults to in-memory in tests/local runs.
 */
import crypto from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { advanceTier, type Tier } from "../tier/tier.js";

/**
 * A verifiable membership credential (design.md → `MembershipCredential`).
 *
 *  - `memberId`  opaque, non-PII, deterministic per customer (Req 19.5).
 *  - `tier`      the customer's current membership tier (Req 19.6).
 *  - `signature` HMAC over `memberId + tier` with the dedicated key.
 *  - `qrPayload` the compact string a QR encodes and a scanner presents back to
 *                {@link MembershipCredentialService.verifyCredential} — this IS
 *                the "signed member identifier".
 */
export interface MembershipCredential {
  memberId: string;
  tier: Tier;
  signature: string;
  qrPayload: string;
}

/** The result of verifying a presented credential (design.md contract). */
export interface CredentialVerification {
  /** True iff the presented identifier was validly signed by this service. */
  valid: boolean;
  /** The membership tier carried by a valid credential; omitted when invalid (Req 19.5). */
  tier?: Tier;
}

/**
 * The membership-facts source used only when ISSUING a credential: resolves a
 * local `customers.id` to the customer's current tier, or `null` when no such
 * member exists. Expressed as an injectable interface so issuing is unit
 * testable with an in-memory fake and never requires a live Postgres (mirrors
 * the balance/resolver source pattern). Verification does NOT use this — it is
 * self-contained via the signature.
 */
export interface MembershipTierSource {
  loadTier(customerId: string): Promise<Tier | null>;
}

/**
 * Thrown when a membership operation is attempted without the dedicated signing
 * key configured. The routes map this to a fail-closed "service unavailable"
 * so no unsigned credential is ever issued or trusted (Req 19.5).
 */
export class MembershipKeyUnavailableError extends Error {
  constructor() {
    super("The membership-credential signing key is not configured; the service is unavailable.");
    this.name = "MembershipKeyUnavailableError";
  }
}

/** Thrown by {@link DefaultMembershipCredentialService.issueCredential} when the customer is not a member. */
export class MemberNotFoundError extends Error {
  constructor() {
    super("No loyalty member exists for the resolved identity.");
    this.name = "MemberNotFoundError";
  }
}

/** Version tag prefixed to the QR payload so the format can evolve additively. */
const QR_VERSION = "AML1" as const;

/** Domain separators so the two HMAC uses of the key can never collide. */
const MEMBER_ID_DOMAIN = "athoor:member:";
const SIGNATURE_DOMAIN = "athoor:cred:";

/** base64url(HMAC-SHA256(key, message)) — no padding, URL/QR-safe. */
function hmacB64Url(key: string, message: string): string {
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

/**
 * The Membership-Credential service (design.md → Component 8). Signs/verifies
 * with a single dedicated key; reads tier from an injected source only when
 * issuing.
 */
export interface MembershipCredentialService {
  /** Issue a signed credential (opaque id + tier + signature + QR) for a member. */
  issueCredential(customerId: string): Promise<MembershipCredential>;
  /** Verify a presented signed member identifier, returning `{ valid, tier? }` only. */
  verifyCredential(signedMemberId: string): Promise<CredentialVerification>;
}

/**
 * Default {@link MembershipCredentialService} implementation.
 *
 * @param signingKey the DEDICATED membership signing key (Req 19.5). When
 *                   `undefined`/empty the service is unavailable and every
 *                   method throws {@link MembershipKeyUnavailableError}.
 * @param tierSource resolves a customer's current tier when issuing.
 */
export class DefaultMembershipCredentialService implements MembershipCredentialService {
  constructor(
    private readonly signingKey: string | undefined,
    private readonly tierSource: MembershipTierSource,
  ) {}

  /** Whether the dedicated signing key is configured (i.e. the service is available). */
  get isAvailable(): boolean {
    return typeof this.signingKey === "string" && this.signingKey.length > 0;
  }

  private requireKey(): string {
    if (!this.isAvailable) {
      throw new MembershipKeyUnavailableError();
    }
    return this.signingKey as string;
  }

  /**
   * Derive the OPAQUE, non-PII member id for a customer: a deterministic
   * base64url HMAC of the local customer id under the dedicated key. Stable per
   * customer (so a wallet pass keeps one id) and not reversible without the key.
   */
  private deriveMemberId(key: string, customerId: string): string {
    return hmacB64Url(key, MEMBER_ID_DOMAIN + customerId);
  }

  /** Sign the `memberId + tier` binding with the dedicated key. */
  private sign(key: string, memberId: string, tier: Tier): string {
    return hmacB64Url(key, `${SIGNATURE_DOMAIN}${memberId}:${tier}`);
  }

  async issueCredential(customerId: string): Promise<MembershipCredential> {
    const key = this.requireKey();

    const tier = await this.tierSource.loadTier(customerId);
    if (tier === null) {
      throw new MemberNotFoundError();
    }

    const memberId = this.deriveMemberId(key, customerId);
    const signature = this.sign(key, memberId, tier);
    // Compact, QR-safe payload: version.memberId.tier.signature. This is the
    // "signed member identifier" a scanner presents back to verifyCredential.
    const qrPayload = `${QR_VERSION}.${memberId}.${tier}.${signature}`;

    return { memberId, tier, signature, qrPayload };
  }

  async verifyCredential(signedMemberId: string): Promise<CredentialVerification> {
    const key = this.requireKey();

    // Parse `version.memberId.tier.signature`. Any structural problem is simply
    // an invalid credential — never an error that leaks detail.
    if (typeof signedMemberId !== "string") {
      return { valid: false };
    }
    const parts = signedMemberId.split(".");
    if (parts.length !== 4) {
      return { valid: false };
    }
    const [version, memberId, tierPart, providedSignature] = parts;
    if (version !== QR_VERSION || !memberId || !tierPart || !providedSignature) {
      return { valid: false };
    }

    // Recompute the expected signature over the presented memberId + tier and
    // compare in CONSTANT TIME. A length mismatch is a definitive non-match and
    // leaks no timing information (mirrors the webhook / App Proxy verifiers).
    const expected = Buffer.from(this.sign(key, memberId, tierPart as Tier), "utf8");
    const provided = Buffer.from(providedSignature, "utf8");
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      return { valid: false };
    }

    // Valid: return MEMBERSHIP + TIER ONLY. Never the memberId, the customer id,
    // or any other customer's data (Req 19.5).
    return { valid: true, tier: tierPart as Tier };
  }
}

/**
 * In-memory {@link MembershipTierSource} backed by a `customerId → tier` map.
 * The default source for local runs and tests, so credential issuing runs with
 * no live Postgres. An unknown customer resolves to `null` (fail closed → not a
 * member), matching the identity/resolver pattern.
 */
export class InMemoryMembershipTierSource implements MembershipTierSource {
  private readonly byCustomerId: Map<string, Tier>;

  constructor(entries: Record<string, Tier> | Map<string, Tier> = {}) {
    this.byCustomerId =
      entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async loadTier(customerId: string): Promise<Tier | null> {
    return this.byCustomerId.get(customerId) ?? null;
  }

  /** Test/setup helper: register a customer's tier. */
  set(customerId: string, tier: Tier): void {
    this.byCustomerId.set(customerId, tier);
  }
}

/** The minimal read-only DB surface {@link PgMembershipTierSource} needs. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

const SELECT_MEMBER_TIER_SQL = `
  SELECT lifetime_spend_gbp, tier
  FROM customers
  WHERE id = $1
  LIMIT 1
`;

interface MemberTierRow extends QueryResultRow {
  lifetime_spend_gbp: string | number | null;
  tier: string | null;
}

/** Parse a NUMERIC/BIGINT column (`pg` returns NUMERIC as a string) to a finite number. */
function parseSpendColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed {@link MembershipTierSource}: reads the customer's retained
 * `tier` and `lifetime_spend_gbp` and returns the RETAINED tier via
 * {@link advanceTier} (never below the stored tier, Req 7.3/7.7). Returns `null`
 * when no such customer row exists. Read-only; no ledger interaction.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing. Not used by tests or local runs
 * — the in-memory source is the default so no live Postgres is required.
 */
export class PgMembershipTierSource implements MembershipTierSource {
  constructor(private readonly db: Queryable) {}

  async loadTier(customerId: string): Promise<Tier | null> {
    const result = await this.db.query<MemberTierRow>(SELECT_MEMBER_TIER_SQL, [customerId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return advanceTier(row.tier, parseSpendColumn(row.lifetime_spend_gbp));
  }
}

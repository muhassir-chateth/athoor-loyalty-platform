/**
 * Reusable customer enrollment — "a verified Shopify customer exists but no
 * local enrollment row does".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Enrollment used to happen through exactly ONE door: the `customers/create`
 * webhook (`earning/signup.ts`). `PgCustomerResolver` does a read-only
 * `SELECT id FROM customers WHERE shopify_customer_id = $1` and `plugins/auth.ts`
 * turns a `null` into HTTP 401 `identity_resolution_failed`. So a verified,
 * logged-in Shopify customer who never happened to pass through that one webhook
 * — every customer who predates the service, and every customer whose webhook
 * was missed — is permanently locked out of `/v1`, with no repair path.
 *
 * The repair must NOT be an ad-hoc INSERT bolted into the auth plugin. Auth's
 * job is to decide *who you are*; creating loyalty state is a domain decision
 * with money attached (a signup bonus). So enrollment is factored out here as
 * ONE implementation with THREE callers:
 *
 *   1. the `customers/create` webhook path  → {@link handleCustomersCreateEnrollment}
 *   2. an authenticated first-request fallback → {@link LazyEnrollmentGate}
 *   3. historical migration / backfill       → {@link backfillEnrollment}
 *
 * THE POPULATION PROBLEM (the reason this is not just "upsert and award +50")
 * -------------------------------------------------------------------------
 * Two populations reach this code and they must be treated differently:
 *
 *   - Population A — a genuinely NEW Shopify customer. They get the normal
 *     signup reward exactly once (Req 2.1: exactly one +50 `earn_signup`).
 *   - Population B — the historical cohort. Their balance and history come from
 *     the approved M0→M1 migration (`migration/m1Backfill.ts`). Creating or
 *     repairing their local row is BOOKKEEPING, not a signup event. Crediting
 *     them a fresh +50 because a row happened to be missing would invent points
 *     that no rule earned.
 *
 * The distinction is made in TWO independent layers, so no single mistake can
 * award points to Population B:
 *
 *   LAYER 1 — the TRIGGER declares eligibility, and the default is "no award".
 *     Only `customers/create` can assert "this Shopify customer is new", because
 *     Shopify only fires it when the customer account is created. The lazy
 *     fallback and the backfill assert nothing of the kind — they observe that a
 *     local row is MISSING, which says nothing about whether the customer is new.
 *     A missing row is a defect in our data, not a signup. See
 *     {@link TRIGGER_SIGNUP_AWARD_POLICY}.
 *
 *   LAYER 2 — the LEDGER vetoes, even on the webhook path. Before any award we
 *     read the customer's own ledger for two markers:
 *       * an `entry_type = 'migration'` entry — the marker M1 stamps on every
 *         migrated customer (`m1Backfill.ts` → `MIGRATION_ENTRY_TYPE`). Its
 *         presence means "this customer's opening balance was migrated", so they
 *         are Population B by their own recorded history.
 *       * an existing `earn_signup` — they have already been paid.
 *     Either marker vetoes the award. This is defence in depth: if a
 *     `customers/create` were ever replayed, re-fired, or fired for a
 *     re-created historical account, Layer 2 still refuses.
 *
 * Because the veto is derived from the ledger — the append-only source of truth —
 * rather than from a flag someone has to remember to set, it is durable and
 * directly testable.
 *
 * WHY THE AWARD IS DELEGATED, NEVER REIMPLEMENTED
 * ----------------------------------------------
 * When an award IS due we call the EXISTING {@link earnSignup}. It already owns
 * the per-customer `earn_signup` idempotency guard, the exact +50 amount, the
 * matching 12-month Point_Lot, and referral-code assignment. Reimplementing any
 * of that here would create a second, drifting definition of "the signup award"
 * and a second idempotency mechanism to keep in sync. The guard inside
 * `earnSignup` therefore stays the single business key for "this customer has
 * been paid their signup bonus", exactly as required.
 *
 * RACE SAFETY
 * -----------
 * Two simultaneous first requests must produce exactly ONE customer and exactly
 * ONE award. Both properties come from the EXISTING unique constraint
 * `customers.shopify_customer_id BIGINT UNIQUE` plus one transaction:
 *
 *   - Exactly one customer: {@link ENROL_CUSTOMER_SQL} is
 *     `INSERT ... ON CONFLICT (shopify_customer_id) DO UPDATE ... RETURNING id`.
 *     The loser of the race conflicts and updates instead of inserting, and both
 *     callers return the SAME `customers.id`. A duplicate row is impossible —
 *     the database refuses it, we do not merely hope to avoid it.
 *
 *   - Exactly one award: the upsert is ALSO the per-customer serialisation
 *     point, and this is the load-bearing detail. `ON CONFLICT DO UPDATE` takes
 *     a row-level exclusive lock on that customer's row and holds it until
 *     COMMIT. A concurrent enrollment for the same Shopify id therefore BLOCKS
 *     on the upsert until the first transaction commits. Only then does it run
 *     its classification read and `earnSignup`'s guard — and by then the first
 *     transaction's `earn_signup` is committed and visible, so the guard sees it
 *     and declines. The SELECT-then-INSERT guard is safe here precisely because
 *     it can never run concurrently for the same customer.
 *
 *     This is why the customer upsert MUST come first and MUST be in the same
 *     transaction as the classification and the award. Ordering is the mechanism.
 *
 * SECURITY
 * --------
 * The identity enrolled by the fallback comes ONLY from a value Shopify itself
 * supplied on a request whose App Proxy signature already verified (or from a
 * verified Customer Account API token subject). {@link LazyEnrollmentGate}
 * accepts a single already-verified id string and is deliberately given NO
 * access to the Fastify request, so a body field, query parameter, browser-set
 * header, or browser-supplied email CANNOT select the customer being enrolled —
 * not by policy, but because that data is not reachable from here.
 *
 * SAFETY: defining this module touches no live system and calls no Shopify API.
 * It issues SQL only when a caller passes a real Pool/PoolClient/transaction
 * client at runtime; every path is unit tested against in-memory fakes.
 */
import { z } from "zod";
import type { LedgerRepository, Queryable } from "../ledger/repository.js";
import { MIGRATION_ENTRY_TYPE } from "../migration/m1Backfill.js";
import { earnSignup, SIGNUP_POINTS, type Transactor } from "../earning/signup.js";
import { CUSTOMERS_CREATE_TOPIC } from "../earning/signup.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

/**
 * Which caller asked for enrollment. This is not decoration: the trigger is the
 * FIRST of the two gates on the signup award (see {@link TRIGGER_SIGNUP_AWARD_POLICY}),
 * so every call site must state, on the record, what it actually knows.
 */
export const ENROLLMENT_TRIGGERS = [
  /** Shopify's verified `customers/create` webhook — the only genuine "new customer" signal. */
  "webhook_customers_create",
  /** An authenticated `/v1` request whose customer has no local row yet (repair). */
  "authenticated_fallback",
  /** Historical migration / operator backfill (repair). */
  "migration_backfill",
] as const;

export type EnrollmentTrigger = (typeof ENROLLMENT_TRIGGERS)[number];

/**
 * Whether a trigger is even ALLOWED to award the signup bonus.
 *
 *  - `award_when_genuinely_new` — the trigger asserts the Shopify customer was
 *    just created, so an award may be considered (Layer 2 still has a veto).
 *  - `never_award` — the trigger only observed that a local row was MISSING.
 *    That is a gap in our data, not a signup event, so no award is ever
 *    considered. This is what stops Population B being credited +50 merely
 *    because enrollment was repaired.
 *
 * DEFAULT-DENY BY CONSTRUCTION: only `customers/create` — the one signal Shopify
 * emits exclusively for a newly created account — is eligible. Any trigger added
 * later must opt IN here explicitly and justify itself in review.
 */
export const TRIGGER_SIGNUP_AWARD_POLICY: Readonly<Record<EnrollmentTrigger, SignupAwardPolicy>> = {
  webhook_customers_create: "award_when_genuinely_new",
  authenticated_fallback: "never_award",
  migration_backfill: "never_award",
};

export type SignupAwardPolicy = "award_when_genuinely_new" | "never_award";

/**
 * Which population the customer's OWN LEDGER says they belong to.
 *  - `legacy_migrated` — carries a `migration` entry: their opening balance came
 *    from the approved M0→M1 migration, so they are never a fresh signup.
 *  - `new_or_unknown` — no migration marker. A genuinely new customer looks like
 *    this, and so does a historical customer who was never backfilled; that is
 *    exactly why the TRIGGER gate exists and why a repair never awards.
 */
export type EnrollmentPopulation = "legacy_migrated" | "new_or_unknown";

/** Why the signup award was or was not made. Reported so the decision is auditable. */
export type SignupAwardDecision =
  /** A fresh +50 `earn_signup` was appended by {@link earnSignup}. */
  | "awarded"
  /** The trigger only repaired a missing row; a repair is never a signup (Population B safe). */
  | "skipped_trigger_not_eligible"
  /** The customer carries migrated legacy state — their balance already came from migration. */
  | "skipped_legacy_migrated_state"
  /** An `earn_signup` already existed; the existing guard declined (any ordering). */
  | "skipped_already_awarded";

/** The outcome of an enrollment attempt. */
export interface EnrollmentOutcome {
  /** The local `customers.id` — always resolved, whether created now or already present. */
  customerId: string;
  /** True only when THIS call inserted the row; false when it already existed. */
  createdCustomer: boolean;
  /** What the customer's own ledger says about which population they are in. */
  population: EnrollmentPopulation;
  /** The award decision, and why. */
  signupAward: SignupAwardDecision;
  /** The `earn_signup` entry id when one was appended, else null. */
  ledgerEntryId: string | null;
  /** Points credited by this call: {@link SIGNUP_POINTS} on an award, else 0. */
  pointsAwarded: number;
}

/** Input to {@link ensureCustomerEnrollment}. */
export interface EnsureEnrollmentInput {
  /**
   * The numeric Shopify customer id. On the fallback path this MUST have come
   * from a verified `logged_in_customer_id` (or a verified Customer Account API
   * token subject) — never from a request body, query parameter, browser header,
   * or browser-supplied email.
   */
  shopifyCustomerId: number;
  /** Email from a TRUSTED source (the webhook payload / migration export) only. */
  email?: string | null;
  /** Which caller asked; gates the award (Layer 1). */
  trigger: EnrollmentTrigger;
  /** Webhook id or backfill run id, recorded on the ledger entry for traceability. */
  sourceEventId?: string | null;
}

/** Dependencies for enrollment. Every external boundary is injected. */
export interface EnrollmentDeps {
  /** The append-only ledger repository — the only sanctioned ledger writer. */
  repo: LedgerRepository;
  /**
   * OPTIONAL referral-code assigner, forwarded to {@link earnSignup} so a newly
   * awarded member leaves enrollment with a shareable code, exactly as the
   * webhook path does today.
   */
  ensureReferralCode?: (customerId: string, tx: Queryable) => Promise<void>;
}

/** Dependencies for the transaction-owning entry points. */
export interface TransactionalEnrollmentDeps extends EnrollmentDeps {
  /** Runs enrollment atomically; the upsert's row lock serialises concurrent callers. */
  transactor: Transactor;
}

/** Thrown when a caller supplies an id that is not a usable Shopify customer id. */
export class InvalidEnrollmentIdentityError extends Error {
  readonly code = "invalid_enrollment_identity";
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnrollmentIdentityError";
  }
}

/**
 * Resolve-or-create the customer, keyed by the Shopify id's UNIQUE constraint.
 *
 * Deliberately the same upsert shape the webhook path already uses
 * (`signup.ts` → `UPSERT_CUSTOMER_SQL`), so enrollment cannot drift from it:
 * `enrolled_at` and `email` are set on first write and PRESERVED by COALESCE on
 * every later one, so repairing a row never overwrites established state.
 *
 * `xmax = 0` distinguishes a genuine INSERT from a conflicting UPDATE in the
 * SAME statement — a standard Postgres idiom. Reporting `createdCustomer`
 * separately from the award matters because "we created the row" and "we paid
 * the bonus" are exactly the two things that must not be conflated.
 */
const ENROL_CUSTOMER_SQL = `
  INSERT INTO customers (shopify_customer_id, email, enrolled_at)
  VALUES ($1, $2, now())
  ON CONFLICT (shopify_customer_id) DO UPDATE
    SET enrolled_at = COALESCE(customers.enrolled_at, EXCLUDED.enrolled_at),
        email       = COALESCE(customers.email, EXCLUDED.email),
        updated_at  = now()
  RETURNING id, (xmax = 0) AS inserted
`;

/**
 * Classify the customer from their OWN ledger (Layer 2 of the award gate).
 *
 * One round trip answers both questions: are they Population B (a `migration`
 * entry — the marker `m1Backfill.ts` stamps on every migrated customer), and
 * have they already been paid (`earn_signup`)? `bool_or` over the two relevant
 * entry types returns a single row; an empty ledger yields NULLs, read as false.
 *
 * Runs inside the enrollment transaction, AFTER the upsert has taken the row
 * lock, so it observes the committed state of any concurrent enrollment rather
 * than racing it.
 */
const CLASSIFY_CUSTOMER_SQL = `
  SELECT
    bool_or(entry_type = '${MIGRATION_ENTRY_TYPE}') AS has_migration_state,
    bool_or(entry_type = 'earn_signup')             AS has_signup_award
  FROM ledger_entries
  WHERE customer_id = $1
    AND entry_type IN ('${MIGRATION_ENTRY_TYPE}', 'earn_signup')
`;

interface EnrolledCustomerRow {
  id: string;
  inserted: boolean;
}

interface ClassificationRow {
  has_migration_state: boolean | null;
  has_signup_award: boolean | null;
}

/**
 * Ensures a local enrollment row exists for a verified Shopify customer, and
 * awards the signup bonus ONLY when both gates agree it is genuinely due.
 *
 * MUST run inside a transaction: pass the transaction client as `executor` so
 * the upsert, the classification read, and any award commit or roll back as one
 * unit. The upsert's row lock is what makes the whole sequence safe against a
 * concurrent enrollment of the same customer (see the module header).
 *
 * @param deps     ledger repository (+ optional referral-code assigner).
 * @param input    the VERIFIED Shopify customer id and the calling trigger.
 * @param executor the transaction client the whole flow runs within.
 */
export async function ensureCustomerEnrollment(
  deps: EnrollmentDeps,
  input: EnsureEnrollmentInput,
  executor: Queryable,
): Promise<EnrollmentOutcome> {
  assertUsableShopifyCustomerId(input.shopifyCustomerId);

  // (1) Resolve-or-create, and take the per-customer row lock that serialises
  // any concurrent enrollment for this same Shopify id until we commit.
  const upserted = await executor.query<EnrolledCustomerRow>(ENROL_CUSTOMER_SQL, [
    input.shopifyCustomerId,
    input.email ?? null,
  ]);
  const row = upserted.rows[0];
  if (!row) {
    // Unreachable: the upsert always RETURNs a row. Treat a missing id as a
    // failure so the transaction rolls back rather than silently continuing
    // with no customer to attribute anything to.
    throw new Error(
      `Failed to resolve customer id for shopify_customer_id ${input.shopifyCustomerId}.`,
    );
  }
  const customerId = row.id;
  const createdCustomer = row.inserted === true;

  // (2) Layer 2: ask the customer's own ledger which population they are in and
  // whether they have already been paid.
  const classified = await executor.query<ClassificationRow>(CLASSIFY_CUSTOMER_SQL, [customerId]);
  const classification = classified.rows[0];
  const hasMigrationState = classification?.has_migration_state === true;
  const hasSignupAward = classification?.has_signup_award === true;
  const population: EnrollmentPopulation = hasMigrationState ? "legacy_migrated" : "new_or_unknown";

  const noAward = (signupAward: SignupAwardDecision): EnrollmentOutcome => ({
    customerId,
    createdCustomer,
    population,
    signupAward,
    ledgerEntryId: null,
    pointsAwarded: 0,
  });

  // (3) Layer 1: a trigger that merely repaired a missing row never awards.
  // Checked BEFORE the ledger vetoes so the reported reason names the real
  // cause: this call was never eligible in the first place.
  if (TRIGGER_SIGNUP_AWARD_POLICY[input.trigger] === "never_award") {
    return noAward("skipped_trigger_not_eligible");
  }

  // (4) Population B veto: their balance came from the approved migration, so a
  // fresh signup bonus would invent points no rule earned.
  if (hasMigrationState) {
    return noAward("skipped_legacy_migrated_state");
  }

  // (5) Already paid. `earnSignup`'s own guard would also catch this; reading it
  // here lets the outcome say so without a redundant write attempt.
  if (hasSignupAward) {
    return noAward("skipped_already_awarded");
  }

  // (6) Award due. Delegated to the EXISTING signup earning so the +50 amount,
  // the `earn_signup` idempotency guard, the matching 12-month Point_Lot and
  // referral-code assignment keep exactly ONE definition. Its upsert repeats
  // ours, which is harmless (idempotent, same row, lock already held) and is
  // the price of not duplicating the award logic here.
  const outcome = await earnSignup(
    deps.repo,
    {
      shopifyCustomerId: input.shopifyCustomerId,
      email: input.email ?? null,
      sourceEventId: input.sourceEventId ?? null,
    },
    executor,
    deps.ensureReferralCode,
  );

  if (outcome.status === "already_earned") {
    // The existing guard declined — the authoritative answer, so we honour it.
    return noAward("skipped_already_awarded");
  }

  return {
    customerId: outcome.customerId,
    createdCustomer,
    population,
    signupAward: "awarded",
    ledgerEntryId: outcome.entry.id,
    pointsAwarded: outcome.entry.points,
  };
}

/**
 * {@link ensureCustomerEnrollment} wrapped in its own transaction — the form
 * every caller that is not already inside one should use, because the upsert's
 * row lock only serialises concurrent enrollments if it is held to COMMIT.
 */
export async function ensureCustomerEnrollmentInTransaction(
  deps: TransactionalEnrollmentDeps,
  input: EnsureEnrollmentInput,
): Promise<EnrollmentOutcome> {
  return deps.transactor.transaction((tx) => ensureCustomerEnrollment(deps, input, tx));
}

/**
 * Minimal schema for the fields we need from a `customers/create` payload.
 * Mirrors `signup.ts`: Shopify sends a number, we also accept a numeric string.
 */
const customersCreatePayloadSchema = z.object({
  id: z.union([z.number(), z.string()]),
  email: z.string().email().optional().nullable(),
});

/**
 * CALLER 1 — the `customers/create` webhook path.
 *
 * Consumes a VERIFIED, deduplicated `webhook.process` job and enrolls through
 * the shared service with the one trigger that is eligible to award. Reaching
 * here means the HMAC gate passed and the webhook-id dedupe recorded a new event
 * (Req 2.7), so no award is ever created for an unverified event.
 *
 * A job for any other topic returns `null`, so this can sit on the shared
 * `webhook.process` queue without mis-handling order/refund jobs.
 */
export async function handleCustomersCreateEnrollment(
  job: WebhookJob,
  deps: TransactionalEnrollmentDeps,
): Promise<EnrollmentOutcome | null> {
  if (job.topic !== CUSTOMERS_CREATE_TOPIC) {
    return null;
  }

  const parsed = customersCreatePayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new InvalidEnrollmentIdentityError(
      "customers/create payload is missing a usable customer id.",
    );
  }
  const shopifyCustomerId =
    typeof parsed.data.id === "number" ? parsed.data.id : Number(parsed.data.id);
  assertUsableShopifyCustomerId(shopifyCustomerId);

  return ensureCustomerEnrollmentInTransaction(deps, {
    shopifyCustomerId,
    email: parsed.data.email ?? null,
    trigger: "webhook_customers_create",
    sourceEventId: job.webhookId,
  });
}

/**
 * CALLER 3 — historical migration / operator backfill.
 *
 * Creates the local row for a customer whose loyalty state comes from the
 * approved migration, and NEVER credits a signup bonus: the trigger is
 * `never_award`, so repairing history cannot manufacture points. Exposed as its
 * own named function so a backfill script states its intent in one place rather
 * than passing a trigger string around.
 */
export async function backfillEnrollment(
  deps: TransactionalEnrollmentDeps,
  input: { shopifyCustomerId: number; email?: string | null; sourceEventId?: string | null },
): Promise<EnrollmentOutcome> {
  return ensureCustomerEnrollmentInTransaction(deps, {
    shopifyCustomerId: input.shopifyCustomerId,
    email: input.email ?? null,
    trigger: "migration_backfill",
    sourceEventId: input.sourceEventId ?? null,
  });
}

/**
 * Guards the one value that decides WHOSE loyalty state is touched. A
 * non-integer, zero, or negative id never reaches SQL: it means the identity is
 * not understood, and enrolling "someone" on a misunderstood identity is worse
 * than failing the request.
 */
function assertUsableShopifyCustomerId(shopifyCustomerId: number): void {
  if (
    typeof shopifyCustomerId !== "number" ||
    !Number.isInteger(shopifyCustomerId) ||
    !Number.isSafeInteger(shopifyCustomerId) ||
    shopifyCustomerId <= 0
  ) {
    throw new InvalidEnrollmentIdentityError(
      `Refusing to enrol on an unusable Shopify customer id: ${String(shopifyCustomerId)}.`,
    );
  }
}

/**
 * Parses the `logged_in_customer_id` Shopify injected into a numeric id, or
 * returns `null` when it is not a usable positive integer.
 *
 * Returns `null` rather than throwing: a value we cannot make sense of must
 * leave the request unauthenticated (a 401), never turn into a 500 and never be
 * guessed at.
 */
export function parseVerifiedShopifyCustomerId(verified: string): number | null {
  if (typeof verified !== "string" || !/^\d+$/.test(verified)) {
    return null;
  }
  const id = Number(verified);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The boundary the auth layer is allowed to touch (CALLER 2).
 *
 * The signature is the security control. It takes ONE argument: a Shopify
 * customer id the caller has ALREADY verified. It receives no Fastify request,
 * no query object, no headers, no body, and no email — so a browser-supplied
 * value cannot reach enrollment even by mistake, because there is no parameter
 * that could carry it.
 */
export interface VerifiedCustomerEnroller {
  /**
   * Enrols the customer identified by an ALREADY-VERIFIED Shopify customer id
   * and returns the local `customers.id`, or `null` when the fallback is
   * disabled or the id is unusable.
   *
   * @param verifiedShopifyCustomerId a value Shopify itself supplied on a
   *   request whose App Proxy signature verified, or the subject of a verified
   *   Customer Account API token. NEVER a client-controlled value.
   */
  enrollVerifiedCustomer(verifiedShopifyCustomerId: string): Promise<string | null>;
}

/** Options for {@link LazyEnrollmentGate}. */
export interface LazyEnrollmentGateOptions extends TransactionalEnrollmentDeps {
  /**
   * The explicit configuration gate (`ENROLLMENT_LAZY_FALLBACK_ENABLED`,
   * `config.enrollment.lazyFallbackEnabled`), DEFAULTING TO FALSE.
   *
   * Checked here, at the moment of use, as well as at the wiring site. Merging
   * this work therefore changes nothing at runtime, and turning it on later is a
   * reversible config change rather than a deploy.
   */
  enabled: boolean;
  /**
   * OPTIONAL observability hook for a FAILED lazy enrollment. The fallback is a
   * repair, not the point of the request, so a failure must degrade to the
   * normal 401 rather than a 500 — this keeps that from being silent.
   */
  onEnrollmentError?: (err: unknown, verifiedShopifyCustomerId: string) => void;
}

/**
 * CALLER 2 — the authenticated first-request fallback.
 *
 * Repairs the missing local row for a customer Shopify has already vouched for,
 * so their first authenticated `/v1` request succeeds instead of 401ing forever.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *  - it never awards the signup bonus (its trigger is `never_award`), so a
 *    repaired row can never mint +50 for the historical cohort;
 *  - it never accepts an identity from the request — only the single verified id
 *    string it is handed;
 *  - it never runs when the config gate is off, so it is inert until switched on.
 *
 * A failure returns `null`, which the auth layer reads as "identity still
 * unresolved" and answers with the ordinary 401. Enrollment failing must not
 * turn a clean rejection into a server error.
 */
export class LazyEnrollmentGate implements VerifiedCustomerEnroller {
  constructor(private readonly opts: LazyEnrollmentGateOptions) {}

  async enrollVerifiedCustomer(verifiedShopifyCustomerId: string): Promise<string | null> {
    // The config gate, re-checked at the point of use (fail closed).
    if (!this.opts.enabled) {
      return null;
    }

    // Shopify's own injected value is still parsed, never trusted blindly: an
    // unparseable id leaves the request unauthenticated.
    const shopifyCustomerId = parseVerifiedShopifyCustomerId(verifiedShopifyCustomerId);
    if (shopifyCustomerId === null) {
      return null;
    }

    try {
      const outcome = await ensureCustomerEnrollmentInTransaction(this.opts, {
        shopifyCustomerId,
        // No email: the only email a first request could offer comes from the
        // browser, and a browser-supplied email must never help identify or
        // describe the customer being enrolled. The `customers/create` webhook
        // and the reconciliation path own email, from trusted sources.
        email: null,
        trigger: "authenticated_fallback",
        sourceEventId: null,
      });
      return outcome.customerId;
    } catch (err) {
      this.opts.onEnrollmentError?.(err, verifiedShopifyCustomerId);
      return null;
    }
  }
}

/** Re-exported so callers can assert the award amount without importing two modules. */
export { SIGNUP_POINTS };

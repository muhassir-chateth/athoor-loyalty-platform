/**
 * Signup earning (task 4.1).
 *
 * Implements the `customers/create` earning rule of the Loyalty Engine
 * (design.md "Component 2: Loyalty Engine" `earnSignup`; webhook table row
 * `customers/create → earnSignup (+50)`). It creates EXACTLY ONE `earn_signup`
 * ledger entry of EXACTLY +50 points for a newly enrolled customer.
 *
 * Requirements covered:
 *   - 2.1  WHEN a verified `customers/create` webhook is processed for a new
 *          Enrolled_Customer, create exactly one signup earning of exactly 50
 *          points.
 *   - 2.7  On HMAC failure the event never reaches here — the HMAC gate
 *          (task 3.1) rejects with 401 and nothing is enqueued, so this
 *          earning runs ONLY on the verified/deduped hand-off path. The
 *          module exposes no unauthenticated entry point: {@link earnSignup}
 *          is invoked exclusively from {@link handleCustomersCreateJob}, which
 *          consumes the `webhook.process` job produced after verify + dedupe.
 *   - 2.8  On a replayed / duplicate already-earned signup, create no
 *          additional earning and leave all balances unchanged — enforced by a
 *          per-customer `earn_signup` idempotency guard (in addition to the
 *          upstream webhook-id dedupe of task 3.2).
 *   - 2.11 Increase only the affected customer's balance — a single append is
 *          made for exactly the one resolved customer id; no other customer's
 *          rows are touched.
 *
 * Scope: this module owns signup earning only. Tier logic lives in `src/tier/**`
 * (a concurrent task) and is NOT touched here; signup earns a flat 50 points
 * with no tier multiplier, so no tier lookup is required. Order earning
 * (task 4.2) and its point-lots are out of scope. Per Requirements 2.6 / 5.1
 * only paid-order and first-purchase earnings create Point_Lots, so a signup
 * earning appends a single ledger entry and creates no lot here.
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real
 * Pool/PoolClient (or a transaction client) at runtime; all logic is unit
 * tested against an in-memory {@link Queryable} fake, so live DB verification is
 * deferred to deploy time.
 */
import { z } from "zod";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { createExpiringPointLot } from "../ledger/pointLots.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

/** The exact signup earning amount (Requirement 2.1). */
export const SIGNUP_POINTS = 50 as const;

/** The reason recorded on the signup ledger entry. */
export const SIGNUP_REASON = "signup_bonus" as const;

/** The webhook topic this earning responds to. */
export const CUSTOMERS_CREATE_TOPIC = "customers/create" as const;

/**
 * Runs a unit of work inside a single database transaction. The signup flow
 * (resolve/enrol customer → idempotency guard → append) MUST be atomic so a
 * partially-applied signup can never occur; the caller supplies a transactor
 * that BEGINs, passes the transaction client, and COMMITs / ROLLBACKs.
 *
 * Abstracted as an interface so the flow is testable without a live Postgres.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Input to {@link earnSignup}. */
export interface SignupEarnInput {
  /** The numeric Shopify customer id from the `customers/create` payload. */
  shopifyCustomerId: number;
  /** Customer email, if present in the payload (stored, never logged raw). */
  email?: string | null;
  /** X-Shopify-Webhook-Id, recorded on the ledger entry for traceability. */
  sourceEventId?: string | null;
}

/**
 * The outcome of a signup earning attempt.
 *  - `earned`         a new +50 `earn_signup` entry was appended.
 *  - `already_earned` an `earn_signup` already existed for the customer; no
 *                     entry was created and no balance changed (Req 2.8).
 */
export type SignupEarnOutcome =
  | { status: "earned"; customerId: string; entry: LedgerEntry }
  | { status: "already_earned"; customerId: string };

/** Thrown when the `customers/create` payload lacks a usable customer id. */
export class InvalidCustomersCreatePayloadError extends Error {
  readonly code = "invalid_customers_create_payload";
  constructor(message: string) {
    super(message);
    this.name = "InvalidCustomersCreatePayloadError";
  }
}

/**
 * Upserts the customer keyed by Shopify id and marks them enrolled.
 *
 * `customers/create` fires for a new customer, but the upsert makes the step
 * idempotent at the row level: a replay resolves to the same `customers.id`
 * without creating a duplicate. Enrolment is recorded by setting `enrolled_at`
 * the first time (preserved on replay via COALESCE), which is what makes the
 * customer an Enrolled_Customer (Req 2.1). Only `customers` is touched, and
 * only for this one Shopify id (Req 2.11).
 */
const UPSERT_CUSTOMER_SQL = `
  INSERT INTO customers (shopify_customer_id, email, enrolled_at)
  VALUES ($1, $2, now())
  ON CONFLICT (shopify_customer_id) DO UPDATE
    SET enrolled_at = COALESCE(customers.enrolled_at, EXCLUDED.enrolled_at),
        email       = COALESCE(customers.email, EXCLUDED.email),
        updated_at  = now()
  RETURNING id
`;

/**
 * Idempotency guard (Req 2.8): does an `earn_signup` already exist for this
 * customer? Combined with the upstream webhook-id dedupe (task 3.2), this
 * ensures a replayed or re-registered signup never double-credits — even if the
 * replay arrives under a different webhook id.
 *
 * Runs inside the signup transaction so the guard read and the subsequent
 * append are atomic for the customer.
 */
const EXISTING_SIGNUP_SQL = `
  SELECT 1
  FROM ledger_entries
  WHERE customer_id = $1
    AND entry_type = 'earn_signup'
  LIMIT 1
`;

interface CustomerIdRow {
  id: string;
}

/**
 * Creates exactly one +50 `earn_signup` ledger entry for a newly enrolled
 * customer, or no entry at all if one already exists (Requirements 2.1, 2.8,
 * 2.11).
 *
 * MUST run inside a transaction: pass the transaction client as `executor` so
 * the customer upsert, the idempotency guard, and the ledger append commit (or
 * roll back) atomically. This function performs no HMAC/verification itself —
 * it is invoked only from the verified/deduped path (Req 2.7).
 *
 * @param repo     the append-only ledger repository (task 2.1) — the only
 *                 sanctioned writer to `ledger_entries`.
 * @param input    the resolved Shopify customer id (+ optional email/event id).
 * @param executor the transaction client the whole flow runs within.
 */
export async function earnSignup(
  repo: LedgerRepository,
  input: SignupEarnInput,
  executor: Queryable,
  /**
   * OPTIONAL referral-code assigner (task 25). Gives the new member their own
   * shareable code, per the design's `customers/create` → "create
   * `referral_code`". Injected so this module keeps no dependency on the
   * referral module; idempotent, so a replay assigns nothing new.
   */
  ensureReferralCode?: (customerId: string, tx: Queryable) => Promise<void>,
): Promise<SignupEarnOutcome> {
  // (1) Resolve + enrol the customer (idempotent at the row level).
  const upserted = await executor.query<CustomerIdRow>(UPSERT_CUSTOMER_SQL, [
    input.shopifyCustomerId,
    input.email ?? null,
  ]);
  const customerId = upserted.rows[0]?.id;
  if (!customerId) {
    // Should be unreachable: the upsert always RETURNs the row. Treat a missing
    // id as a failure so the transaction rolls back rather than silently
    // skipping the earning.
    throw new Error(
      `Failed to resolve customer id for shopify_customer_id ${input.shopifyCustomerId}.`,
    );
  }

  // (2) Idempotency guard (Req 2.8): if a signup earning already exists for this
  // customer, create nothing and leave the balance unchanged.
  const existing = await executor.query(EXISTING_SIGNUP_SQL, [customerId]);
  if ((existing.rowCount ?? existing.rows.length) > 0) {
    return { status: "already_earned", customerId };
  }

  // (3) Append exactly one +50 signup earning for this customer only
  // (Req 2.1, 2.11). The repository enforces the append-only, positive-earn
  // contract; we run it on the same transaction client for atomicity.
  const entry = await repo.append(
    {
      customerId,
      entryType: "earn_signup",
      points: SIGNUP_POINTS,
      reason: SIGNUP_REASON,
      sourceEventId: input.sourceEventId ?? null,
    },
    executor,
  );

  // (4) Back the credit with a matching 12-month Point_Lot (Req 2.6, Req 1.3a,
  // Property 17). Spendable_Balance is derived solely from lots, so without
  // this the signup bonus would show in history yet never be redeemable.
  await createExpiringPointLot(executor, customerId, entry);

  // (5) Give the new member their own referral code (task 25). The design's
  // webhook table specifies `customers/create` → "create `referral_code`", and
  // a member cannot share a referral until they have one. Idempotent: an
  // existing code is kept, so a replay assigns nothing new. Injected so this
  // module keeps no dependency on the referral module.
  if (ensureReferralCode) {
    await ensureReferralCode(customerId, executor);
  }

  return { status: "earned", customerId, entry };
}

/**
 * Minimal schema for the fields of a Shopify `customers/create` payload we
 * need. Shopify sends the customer id as a number; we accept a number or a
 * numeric string and normalise to a number. Unknown fields are ignored.
 */
const customersCreatePayloadSchema = z.object({
  id: z.union([z.number(), z.string()]),
  email: z.string().email().optional().nullable(),
});

/** Parses and validates the numeric Shopify customer id out of a payload. */
function extractShopifyCustomerId(payload: unknown): { id: number; email: string | null } {
  const parsed = customersCreatePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidCustomersCreatePayloadError(
      "customers/create payload is missing a usable customer id.",
    );
  }
  const raw = parsed.data.id;
  const id = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InvalidCustomersCreatePayloadError(
      `customers/create payload carried an invalid customer id: ${String(raw)}.`,
    );
  }
  return { id, email: parsed.data.email ?? null };
}

/** Dependencies for the `customers/create` job handler. */
export interface SignupJobDeps {
  repo: LedgerRepository;
  transactor: Transactor;
  /**
   * OPTIONAL referral-code assigner (task 25), forwarded to {@link earnSignup}
   * so a new member leaves signup with a shareable code. Omitted in tests and
   * local runs, where signup behaves exactly as before.
   */
  ensureReferralCode?: (customerId: string, tx: Queryable) => Promise<void>;
}

/*
 * REMOVED 2026-08-22 — `handleCustomersCreateJob`.
 *
 * It consumed the verified `customers/create` job and called {@link earnSignup}
 * directly. That made it a SECOND enrollment implementation alongside
 * `enrollment/ensureCustomerEnrollment.ts`, and the two disagreed on one thing
 * that matters: only the enrollment service knows about MIGRATED customers. A
 * `customers/create` replayed or re-fired for a customer whose opening balance
 * came from the M0→M1 migration would have been credited a fresh +50 on top of
 * their imported legacy balance.
 *
 * `customers/create` is now dispatched (in `worker.ts`) through
 * `handleCustomersCreateEnrollment`, which upserts the customer, classifies them
 * against their own ledger, and only then delegates the award to {@link earnSignup}.
 *
 * {@link earnSignup} itself is UNCHANGED and remains the single definition of the
 * signup award — the +50 amount, the per-customer `earn_signup` idempotency
 * guard, the 12-month Point_Lot and referral-code assignment all still live here
 * and are still the only implementation of them. What was removed is a duplicate
 * ENTRY POINT, not the award logic.
 *
 * `SignupJobDeps` above is retained: `worker.ts` still uses it to type the
 * optional `ensureReferralCode` collaborator that is forwarded through.
 */

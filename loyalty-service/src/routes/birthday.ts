/**
 * `GET` and `PUT /v1/profile/birthday` (N10, N11) — spec task 12.2, design §11.10,
 * Req 11.1–11.9, 21.7.
 *
 * ── THREE INDEPENDENT VALIDATION LAYERS (task 12.1) ─────────────────────────
 * `zod` with `.strip()` bounds the request and DROPS anything else — so a body
 * carrying `year` cannot reach the handler, which is how Req 11.10's "no birth year"
 * becomes structural rather than a check. `validateBirthday` then refuses impossible
 * calendar combinations. The database `CHECK` refuses them a third time. Three layers
 * because they fail at three different moments, and the last one holds even if a
 * future writer bypasses the first two.
 *
 * ── THE TWO WRITE PATHS ARE SEPARATE ON PURPOSE ─────────────────────────────
 * A first-time set is always permitted; a change is gated by 365 days. So `PUT` tries
 * `INSERT … ON CONFLICT DO NOTHING` first and, only if that created nothing, issues
 * the conditional `UPDATE`. An upsert would collapse the two and let a change slip
 * through the creation path, bypassing the lock entirely.
 *
 * ── NO SECOND REWARD MECHANISM, AND NO SCHEDULED JOB ────────────────────────
 * Eligibility is evaluated ON READ (§11.6). This module does not award points, does
 * not touch the ledger, and adds no job: it reports a state and, where a grant is
 * claimed, records the claim in `birthday_grants`. The existing engine remains the
 * only thing that can move a balance. `claimGrantForYear` returning `true` is the
 * ONLY signal that would permit an award, and the UNIQUE constraint means it can be
 * true at most once per customer per Europe/London year.
 *
 * ── ERRORS ARE CODES, NOT SENTENCES ─────────────────────────────────────────
 * `400 invalid_request` carries `fields: [{ field, code }]` (Req 21.7, design E.1
 * rule 4). The client owns the wording, which is what lets it change without a
 * service deploy and lets a mobile client use its own.
 *
 * SAFETY: writes only `customer_birthdays` and `birthday_grants`, both through the
 * scope-typed repository. No ledger read or write.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import {
  changeBirthdayIfUnlocked,
  createBirthdayIfAbsent,
  hasGrantForYear,
  readBirthday,
} from "../portal/repository/birthday.js";
import {
  BIRTHDAY_CHANGE_LOCK_DAYS,
  BIRTHDAY_WINDOW_DAYS,
  changeAllowedFrom,
  deriveEligibilityState,
  londonDateOf,
  resolveWindow,
  validateBirthday,
  type BirthdayFieldError,
} from "../profile/birthday.js";
import type { PortalBirthdayResponse } from "../portal/types.js";
import { createRedemptionRateLimiter, type RedemptionRateLimiterOptions } from "../plugins/rateLimit.js";

/** `PUT /v1/profile/birthday` rate limit: 5 per hour per customer (task 12.2). */
export const BIRTHDAY_RATE_LIMIT_MAX_REQUESTS = 5 as const;
export const BIRTHDAY_RATE_LIMIT_WINDOW_MS = 3_600_000 as const;

/**
 * The N11 body schema.
 *
 * `.strip()` IS LOAD-BEARING, not tidiness: it removes every unknown key, so a client
 * that posts `{ month, day, year }` has the year discarded before any code sees it.
 * Req 11.10 forbids collecting a birth year, and a field that cannot arrive cannot be
 * stored by accident.
 */
export const BIRTHDAY_BODY_SCHEMA = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .strip();

/**
 * Raised when no executor is wired. See {@link registerBirthdayRoutes}.
 */
export class BirthdayStoreUnconfiguredError extends Error {
  readonly code = "birthday_store_unconfigured" as const;
  constructor() {
    super("No database executor is configured for the birthday routes.");
    this.name = "BirthdayStoreUnconfiguredError";
  }
}

/** The executor used when none is wired: it refuses rather than inventing a state. */
const UNCONFIGURED_DB: Queryable = {
  async query(): Promise<never> {
    throw new BirthdayStoreUnconfiguredError();
  },
};

/** Injectable clock so the Europe/London boundary cases are ordinary unit tests. */
export interface BirthdayClock {
  now(): Date;
}

/** Options accepted by {@link registerBirthdayRoutes}. */
export interface BirthdayRouteOptions {
  /** Absent → {@link UNCONFIGURED_DB}, which REFUSES. The routes register regardless. */
  db?: Queryable;
  clock?: BirthdayClock;
  birthdayRateLimit?: RedemptionRateLimiterOptions;
  rateLimiter?: preHandlerAsyncHookHandler;
}

/**
 * What a body that is not an object at all reduces to: both fields absent.
 * A `PUT` carrying `"hello"`, `42`, or `[]` is a body with no month and no day, which
 * is exactly what the caller needs to be told.
 */
const BOTH_REQUIRED: readonly BirthdayFieldError[] = [
  { field: "month", code: "required" },
  { field: "day", code: "required" },
];

/** Reads an untrusted body as a bag of unknowns without asserting it is one. */
function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * Guarantees a schema rejection is always REPORTED as at least one field.
 *
 * The schema and the calendar validator should never disagree — the schema only
 * constrains month and day, and the validator covers every way either can be wrong.
 * But "should never" is not "cannot", and a `400` carrying `fields: []` would tell a
 * client something was wrong while naming nothing, which is unactionable. So a
 * disagreement degrades to both-fields-required rather than to silence.
 */
function nonEmptyFailure(errors: readonly BirthdayFieldError[]): readonly BirthdayFieldError[] {
  return errors.length > 0 ? errors : BOTH_REQUIRED;
}

/** Builds the one response shape both N10 and N11 return (§11.10). */
async function buildResponse(
  db: Queryable,
  scope: CustomerScope,
  now: Date,
): Promise<PortalBirthdayResponse> {
  const stored = await readBirthday(db, scope);
  const today = londonDateOf(now);
  // `grant_year` is the EUROPE/LONDON year, so a grant taken at 00:30 on 1 January
  // belongs to the new year in the customer's own reckoning (§11.8).
  const granted = stored === null ? false : await hasGrantForYear(db, scope, today.year);

  const windowOpensOn =
    stored === null ? null : resolveWindow(stored.birthday, today, BIRTHDAY_WINDOW_DAYS).opensOn;
  const allowedFrom =
    stored === null ? null : changeAllowedFrom(stored.changedAt, now, BIRTHDAY_CHANGE_LOCK_DAYS);

  return {
    birthday: stored === null ? null : stored.birthday,
    eligibility: {
      state: deriveEligibilityState(
        stored === null ? null : stored.birthday,
        today,
        granted,
        BIRTHDAY_WINDOW_DAYS,
      ),
      windowOpensOn,
      windowDays: BIRTHDAY_WINDOW_DAYS,
    },
    changeable: {
      // A customer with no birthday yet may always set one.
      allowed: stored === null ? true : allowedFrom === null,
      allowedFrom,
    },
  };
}

/**
 * Registers `GET` and `PUT /v1/profile/birthday`. MUST be called inside the `/v1`
 * router scope so auth and idempotency have already run.
 */
export function registerBirthdayRoutes(
  app: FastifyInstance,
  opts: BirthdayRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY. The route census drives every `/v1` route through
  // three unauthorised scenarios, and a route that vanishes when a dependency is
  // absent silently leaves that sweep — so absence becomes a refusing executor
  // rather than a missing route. It also means an un-wired build fails loudly
  // instead of answering `404`, which a client would read as "this account has no
  // birthday feature" rather than "this build is misconfigured".
  const db: Queryable = opts.db ?? UNCONFIGURED_DB;
  const clock = opts.clock ?? { now: () => new Date() };
  // ROUTE-LEVEL (task 10.4). A scope-level limiter would make reading a birthday
  // consume a change's allowance and would run before auth resolved an identity.
  const rateLimiter =
    opts.rateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: BIRTHDAY_RATE_LIMIT_MAX_REQUESTS,
      windowMs: BIRTHDAY_RATE_LIMIT_WINDOW_MS,
      subject: "birthday",
      ...(opts.birthdayRateLimit ?? {}),
    });

  // N10 — read.
  app.get("/profile/birthday", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    void reply;
    return buildResponse(db, scope, clock.now());
  });

  // N11 — set or change. Idempotency-Key is required by the `/v1`-wide plugin.
  app.put(
    "/profile/birthday",
    { preHandler: [rateLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Identity FIRST, so a stranger learns nothing about which dates are valid.
      const scope = requireCustomerScope(req);

      // LAYER ONE bounds the request and strips unknown keys, so `year` is gone before
      // anything below can see it (Req 11.10).
      const parsed = BIRTHDAY_BODY_SCHEMA.safeParse(req.body);

      // LAYER TWO is also what names the fault. `validateBirthday` ALREADY distinguishes
      // missing from non-integer from out-of-range, so translating zod's issue taxonomy
      // into codes here would be a SECOND copy of those rules, free to drift from the
      // first — and it did: zod reports a missing key and a string as the same
      // `invalid_type`, which collapsed `required` into `not_an_integer`. One rule set,
      // one place. On success it still runs, because month and day being individually
      // in range says nothing about whether the PAIR exists in any calendar.
      const raw = asRecord(req.body);
      const fields = parsed.success
        ? validateBirthday(parsed.data.month, parsed.data.day)
        : nonEmptyFailure(validateBirthday(raw.month, raw.day));
      if (fields.length > 0) {
        return reply.code(400).send({ error: "invalid_request", message: "Invalid birthday.", fields });
      }
      // Unreachable unless the two layers disagree, which `nonEmptyFailure` prevents.
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Invalid birthday.",
          fields: BOTH_REQUIRED,
        });
      }

      const birthday = { month: parsed.data.month, day: parsed.data.day };

      // FIRST-TIME SET: always permitted, and separate from the change path so a
      // change cannot slip through it and bypass the 365-day lock.
      const created = await createBirthdayIfAbsent(db, scope, birthday);
      if (!created) {
        // A CHANGE: one conditional UPDATE. Zero rows means the lock held — and two
        // concurrent callers cannot both win, because the predicate is evaluated
        // against the serialised row rather than a value read earlier.
        const changed = await changeBirthdayIfUnlocked(
          db,
          scope,
          birthday,
          BIRTHDAY_CHANGE_LOCK_DAYS,
        );
        if (!changed) {
          const current = await buildResponse(db, scope, clock.now());
          return reply.code(409).send({
            error: "birthday_change_locked",
            message: "A birthday may be changed once a year.",
            // The date the change reopens, so the client states it without arithmetic.
            allowedFrom: current.changeable.allowedFrom,
          });
        }
      }

      return buildResponse(db, scope, clock.now());
    },
  );
}

/**
 * `GET` and `PUT /v1/profile/preferences` (N12, N13) — spec task 13.2,
 * design §12.8, Req 12.1, 12.2, 12.7, 13.1, 13.2, 21.7.
 *
 * ── THE ROUTE HOLDS NO RULES ────────────────────────────────────────────────
 * Vocabularies, caps, defaults and validation all live in `profile/preferences.ts`
 * and this file calls into them. Task 12 shipped a route that re-derived field
 * codes from `zod`'s issue taxonomy alongside a domain validator that already
 * produced them, and the two drifted: `required` came back as `not_an_integer`.
 * There is deliberately no `zod` schema here — a schema would be a second
 * statement of the same rules, and the one that governs storage has to win.
 *
 * ── THE WRITE IS ONE TRANSACTION ────────────────────────────────────────────
 * §12.8: set-replacements per dimension inside one transaction, so a partial
 * failure cannot leave half a dimension applied. The transaction spans EVERY
 * dimension in the body plus the communication update, so a save touching three
 * dimensions either lands completely or not at all.
 *
 * ── THE RESPONSE IS A RE-READ, NOT AN ECHO ──────────────────────────────────
 * `PUT` returns the stored state so the client needs no follow-up read (Req 12.2),
 * and it produces it by READING BACK rather than by reflecting the request. An echo
 * would agree with the request by construction and so could never reveal a write
 * that did not land — which is the one thing this response is useful for.
 *
 * ── MARKETING CONSENT IS NOT HERE ───────────────────────────────────────────
 * Shopify owns it (§13.1, Req 13.4) and N9 carries it. A body naming
 * `marketingConsent` is REJECTED by name rather than stripped, so a client cannot
 * receive a `200` implying consent was recorded somewhere it was not.
 *
 * SAFETY: writes only the two preference tables, through the scope-typed
 * repository. No ledger read or write.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import {
  ensureCommunicationRow,
  readCommunicationPreferences,
  readDeclaredPreferences,
  replaceDeclaredDimension,
  updateCommunicationPreferences,
} from "../portal/repository/preferences.js";
import {
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LIMITS,
  PREFERENCE_VOCABULARY,
  projectCommunication,
  projectDeclared,
  validatePreferencesUpdate,
} from "../profile/preferences.js";
import type { PortalPreferencesResponse } from "../portal/types.js";
import { createRedemptionRateLimiter, type RedemptionRateLimiterOptions } from "../plugins/rateLimit.js";

/** `PUT /v1/profile/preferences` rate limit: 30 per 5 minutes (task 13.2). */
export const PREFERENCES_RATE_LIMIT_MAX_REQUESTS = 30 as const;
export const PREFERENCES_RATE_LIMIT_WINDOW_MS = 300_000 as const;

/** Raised when no executor is wired. See {@link registerPreferencesRoutes}. */
export class PreferenceStoreUnconfiguredError extends Error {
  readonly code = "preference_store_unconfigured" as const;
  constructor() {
    super("No database executor is configured for the preferences routes.");
    this.name = "PreferenceStoreUnconfiguredError";
  }
}

/** The executor used when none is wired: it refuses rather than inventing a state. */
const UNCONFIGURED_DB: Queryable = {
  async query(): Promise<never> {
    throw new PreferenceStoreUnconfiguredError();
  },
};

/**
 * Runs a function inside a database transaction.
 *
 * Structurally identical to the transactor every other consumer declares
 * (`worker.ts`, `redemption/redeem.ts`), and duplicated for the same reason they
 * duplicate it: the modules stay independent of one another, and one pool-backed
 * transactor satisfies them all.
 */
export interface PreferencesTransactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * The transactor used when none is wired.
 *
 * It REFUSES rather than silently running the writes outside a transaction. A
 * pass-through default would be the dangerous kind of convenient: every test would
 * pass, and production would apply set-replacements without atomicity — so a
 * failure part-way through a save would leave a dimension holding neither the old
 * set nor the new one. That is precisely the outcome §12.8 requires a transaction
 * to prevent, and it would be invisible until it happened.
 */
const UNCONFIGURED_TRANSACTOR: PreferencesTransactor = {
  async transaction<T>(): Promise<T> {
    throw new PreferenceStoreUnconfiguredError();
  },
};

/** Options accepted by {@link registerPreferencesRoutes}. */
export interface PreferencesRouteOptions {
  /** Absent → {@link UNCONFIGURED_DB}, which REFUSES. The routes register regardless. */
  db?: Queryable;
  /** Absent → a transactor that REFUSES. Never a pass-through; see the constant. */
  transactor?: PreferencesTransactor;
  preferencesRateLimit?: RedemptionRateLimiterOptions;
  rateLimiter?: preHandlerAsyncHookHandler;
}

/**
 * Builds the one response shape both N12 and N13 return (§12.8).
 *
 * Shared by the read and the write so the two cannot describe the stored state
 * differently — the same reason `buildResponse` is shared in the birthday routes.
 */
async function buildResponse(
  db: Queryable,
  scope: CustomerScope,
): Promise<PortalPreferencesResponse> {
  const [declaredRows, communicationRow] = await Promise.all([
    readDeclaredPreferences(db, scope),
    readCommunicationPreferences(db, scope),
  ]);
  return {
    // The vocabulary travels with every response so the client renders the options
    // the server accepts (§12.2). A client holding its own copy would drift the
    // moment a value was added, which is the coupling being server-owned removes.
    vocabulary: PREFERENCE_VOCABULARY,
    declared: projectDeclared(declaredRows),
    communication: projectCommunication(communicationRow),
    limits: PREFERENCE_LIMITS,
  };
}

/**
 * Registers `GET` and `PUT /v1/profile/preferences`. MUST be called inside the
 * `/v1` router scope so auth and idempotency have already run.
 */
export function registerPreferencesRoutes(
  app: FastifyInstance,
  opts: PreferencesRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY. The route census drives every `/v1` route through
  // three unauthorised scenarios, and a route that vanishes when a dependency is
  // absent silently leaves that sweep. Absence therefore becomes a refusing
  // executor rather than a missing route, so an un-wired build fails loudly
  // instead of answering `404` — which a client would read as "this account has no
  // preferences" rather than "this build is misconfigured".
  const db: Queryable = opts.db ?? UNCONFIGURED_DB;
  const transactor: PreferencesTransactor = opts.transactor ?? UNCONFIGURED_TRANSACTOR;
  // ROUTE-LEVEL (task 10.4). A scope-level limiter would make reading preferences
  // consume a save's allowance and would run before auth resolved an identity.
  const rateLimiter =
    opts.rateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: PREFERENCES_RATE_LIMIT_MAX_REQUESTS,
      windowMs: PREFERENCES_RATE_LIMIT_WINDOW_MS,
      subject: "preference",
      ...(opts.preferencesRateLimit ?? {}),
    });

  // N12 — read.
  app.get("/profile/preferences", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    void reply;
    return buildResponse(db, scope);
  });

  // N13 — write any subset. Idempotency-Key is required by the `/v1`-wide plugin.
  app.put(
    "/profile/preferences",
    { preHandler: [rateLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Identity FIRST, so a stranger learns nothing about which values are valid.
      const scope = requireCustomerScope(req);

      const validation = validatePreferencesUpdate(req.body);
      if (!validation.ok) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Invalid preferences.",
          fields: validation.errors,
        });
      }

      const { declared, communication } = validation.update;

      if (declared.size > 0 || communication.size > 0) {
        await transactor.transaction(async (tx) => {
          // Applied in the canonical dimension order rather than the body's key
          // order, so two clients sending the same change in a different order
          // produce the same sequence of statements — which is what makes a
          // deadlock between two concurrent savers impossible rather than
          // unlikely. Two transactions taking the same row locks in the same
          // order cannot form a cycle.
          for (const dimension of PREFERENCE_DIMENSIONS) {
            const values = declared.get(dimension);
            if (values === undefined) continue;
            await replaceDeclaredDimension(tx, scope, dimension, values);
          }
          if (communication.size > 0) {
            // Create-then-update, so the TABLE's own defaults populate a first
            // write and this path never restates them (see the repository header).
            await ensureCommunicationRow(tx, scope);
            await updateCommunicationPreferences(tx, scope, communication);
          }
        });
      }

      // Read back OUTSIDE the transaction: it has committed, so this reads the
      // durable state rather than the transaction's own view. Reading inside would
      // report what the transaction was about to write, which is an echo wearing a
      // query's clothes.
      return buildResponse(db, scope);
    },
  );
}

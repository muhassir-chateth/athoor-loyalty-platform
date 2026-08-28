/**
 * The portal's authorisation choke point.
 *
 * WHY A BRANDED TYPE RATHER THAN PASSING `customerId: string`
 * ----------------------------------------------------------
 * Every portal read and write is scoped to one customer, and the entire IDOR
 * surface reduces to a single question: where did that customer id come from? A
 * bare `string` cannot answer it. `getOrder(customerId, orderId)` compiles
 * identically whether `customerId` came from a verified App Proxy signature or
 * from `req.body.customerId`, so the type system — the one mechanism that checks
 * every call site on every build — is blind to the only distinction that matters.
 *
 * {@link CustomerScope} closes that hole structurally. It carries a brand keyed on
 * a `unique symbol` that is NOT exported, so a value of this type cannot be
 * constructed anywhere outside this module: not by an object literal, not by
 * spreading an existing scope, not by `satisfies`. The only way to obtain one is
 * {@link requireCustomerScope}, which reads the identity the auth middleware
 * already resolved and refuses when there is none.
 *
 * A cast (`as CustomerScope`) can still defeat any brand — TypeScript has no way
 * to forbid that. What the brand buys is that a cast becomes the ONLY route, and
 * a cast is a visible, greppable, reviewable act. `route census` (task 5.3)
 * enforces that no such cast exists. Compare the status quo, where the unsafe
 * path is indistinguishable from the safe one at every one of hundreds of call
 * sites.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------
 * It does not change the existing engine signatures that take `customerId: string`
 * (Requirement 2.1 keeps them untouched). Portal-facing repository functions
 * accept a `CustomerScope` and perform exactly ONE unwrap to `scope.customerId` at
 * their own boundary; the engines below stay identity-source agnostic, exactly as
 * `AuthCtx` intended.
 *
 * SAFETY: this module is pure. It reads a property the auth preHandler already
 * attached, issues no SQL, and calls no Shopify endpoint.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthCtx } from "./identity.js";

/**
 * The brand. NOT exported, and deliberately declared with `unique symbol` so no
 * structurally-identical type can be written elsewhere: another module can declare
 * its own symbol, but it will not be THIS symbol, so the types stay incompatible.
 *
 * `declare const` means it exists only in the type system — no runtime value is
 * emitted, so the brand costs nothing at runtime and cannot be reached by
 * reflection.
 */
declare const CUSTOMER_SCOPE_BRAND: unique symbol;

/**
 * A verified authorisation scope for exactly one customer.
 *
 * Every field is `readonly`: a scope must never be mutated into referring to a
 * different customer after the fact, which would turn one authorisation decision
 * into authority over another account.
 *
 *  - `customerId` is the LOCAL `customers.id` (UUID), never the raw Shopify id —
 *    the same contract `AuthCtx` already establishes.
 *  - `channel` and `source` are carried through so channel-attributed behaviour
 *    (Requirement 19) can build on this additively rather than re-deriving it.
 */
export interface CustomerScope {
  readonly customerId: string;
  readonly channel: AuthCtx["channel"];
  readonly source: AuthCtx["source"];
  /**
   * Phantom brand. Never read, never written, absent at runtime. Its only job is
   * to make this type unconstructable outside this module.
   */
  readonly [CUSTOMER_SCOPE_BRAND]: true;
}

/**
 * Thrown when a portal handler runs without a resolved identity.
 *
 * `code` matches the string the auth layer already returns for an unresolvable
 * request, so the client-facing contract does not fork: a portal route and a
 * pre-existing `/v1` route fail identically. The scope-level `onError` hook
 * (task 5.2) maps this to HTTP 401 with no stored data changed.
 *
 * It carries NO customer identifier, resource id, or reason detail. An
 * authorisation failure must not become an enumeration oracle — "no such order"
 * and "not your order" have to be indistinguishable from outside.
 */
export class ScopeUnavailableError extends Error {
  readonly code = "identity_resolution_failed" as const;

  constructor(message = "The request has no resolved customer identity.") {
    super(message);
    this.name = "ScopeUnavailableError";
  }
}

/**
 * Narrow guard for the one property this module trusts.
 *
 * `AuthCtx` is attached by the auth preHandler, which only runs after an App Proxy
 * signature verified or a Customer Account API token was accepted. This validates
 * the SHAPE rather than assuming it, because `req.authCtx` is declared optional and
 * a future route registered outside the `/v1` scope would legitimately lack it.
 */
function isUsableAuthCtx(value: unknown): value is AuthCtx {
  if (typeof value !== "object" || value === null) return false;
  const ctx = value as Partial<AuthCtx>;
  return (
    typeof ctx.customerId === "string" &&
    ctx.customerId.length > 0 &&
    (ctx.channel === "web" || ctx.channel === "app") &&
    (ctx.source === "app_proxy" || ctx.source === "customer_account_api")
  );
}

/**
 * THE SOLE CONSTRUCTOR of a {@link CustomerScope}.
 *
 * Reads the identity the auth middleware resolved and refuses when absent or
 * malformed. It takes the REQUEST rather than a customer id on purpose: a
 * function that accepted an id would let a caller supply one, which is precisely
 * the hole this module exists to close.
 *
 * It reads ONLY `req.authCtx`. It never looks at the body, the query string, a
 * header, or a cookie — so no client-controlled value can influence which
 * customer the returned scope authorises. That is a structural property of this
 * function's implementation, not a convention to remember.
 *
 * @throws {ScopeUnavailableError} when identity was not resolved for this request.
 */
export function requireCustomerScope(req: FastifyRequest): CustomerScope {
  const ctx: unknown = (req as { authCtx?: unknown }).authCtx;
  if (!isUsableAuthCtx(ctx)) {
    throw new ScopeUnavailableError();
  }
  // FROZEN, not merely `readonly`. TypeScript's `readonly` is erased at compile
  // time, so without this a handler could reassign `scope.customerId` at runtime
  // and silently convert one authorisation decision into authority over another
  // account — the exact escalation the brand prevents at compile time. Freezing
  // makes that assignment throw in strict mode instead of succeeding quietly, so
  // the guarantee holds in both worlds rather than only in the type checker.
  //
  // The brand is type-level only, so nothing is written for it at runtime. The
  // cast is confined to this one line — the single privileged point in the
  // codebase — which is exactly what makes every other site provably safe.
  return Object.freeze({
    customerId: ctx.customerId,
    channel: ctx.channel,
    source: ctx.source,
  }) as CustomerScope;
}

/**
 * Registers the ONE mapping from {@link ScopeUnavailableError} to HTTP 401.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE HOOK IN THE ROUTER. Once handlers stop
 * guarding locally and start throwing, every route module DEPENDS on this mapping
 * being installed. A module registered on a bare Fastify instance without it does
 * not fail loudly — it returns 500 where it used to return 401, which looks like a
 * server fault rather than a missing composition step. Exporting the mapping means
 * the router and any test harness install the SAME one, so the response shape has
 * a single definition and cannot drift the way the nineteen hand-written copies
 * did (`referral.ts` had already lost its `message`).
 *
 * Fastify encapsulates an error handler to the plugin scope that registers it, so
 * calling this inside the `/v1` plugin confines it to `/v1`.
 *
 * NO STORED DATA CHANGES: the error is raised before any handler body runs, so
 * nothing has been written when this replies (Req 1.4).
 *
 * A scope failure is the FIRST branch and the only one that produces a 401, so a
 * genuine fault is never relabelled as an authorisation problem. The two branches
 * after it exist because "delegate everything else to Fastify" turned out not to be
 * neutral: the framework's default renderer puts `err.message` in the body, which
 * Requirement 2.7 and design E.1 rule 2 forbid. Every error therefore leaves this
 * scope in the portal envelope — `{ error, message }` with an identifier from the
 * E.2 taxonomy — and no exception text reaches a customer.
 */
export function registerCustomerScopeErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ScopeUnavailableError) {
      return reply.code(401).send({
        error: error.code,
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    // A body that could not be read AS DECLARED -> 400 invalid_request.
    //
    // Fastify raises these before any handler runs, so they never reached a route's
    // own zod schema and were previously answered by the framework's default
    // renderer. Task 16.5 found four reachable triggers, all on live portal routes:
    // `content-type: application/json` with an empty body (the common shape of a
    // bodyless `POST /v1/profile/visit` from a client that sets the header
    // globally), malformed JSON, an unsupported media type (a form-encoded or
    // multipart write, and the no-content-type case), and a body over the limit.
    // It also covers the `__proto__`/`constructor` payloads `secure-json-parse`
    // refuses, which is why a prototype-pollution attempt is a clean 400.
    //
    // All four are ONE fact from the customer's side — the request was not
    // readable — so all four map to the single identifier design E.2 binds to 400.
    // Task 16.6 requires exactly this for the form-encoded case. Keeping 415 or 413
    // would need identifiers E.2 does not define, and E.1 rule 5 makes an
    // undefined identifier render as the neutral state, which is strictly worse
    // than the accurate `invalid_request` a client already handles.
    if (isUnreadableRequestError(error)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "The request could not be read.",
      });
    }

    // Anything unmapped -> 500 internal_error, with the exception EXCLUDED.
    //
    // WHAT THIS REPLACES, AND WHY IT MATTERS. `reply.send(error)` serialised the
    // exception with Fastify's default renderer, which puts `err.message` in the
    // body verbatim. Task 16.5 demonstrated the consequence with a realistic
    // Postgres failure: the customer received the SQL statement, the table name
    // and an absolute server path from the stack — a direct breach of
    // Requirement 2.7 and of design E.1 rule 2 ("Postgres error text, and
    // `err.message` are never placed in a response body"), reachable from every
    // portal endpoint whose dependency throws.
    //
    // E.2 defines this row precisely: `internal_error`, 500, "anything unmapped",
    // and "the exception never reaches the body". Routes map their own typed
    // errors and `throw` only what they do not recognise, so nothing that has a
    // designed response is affected by this branch.
    //
    // The exception is not lost — it is LOGGED through the sanctioned `err`
    // reshaping in `observability/logRedaction.ts`, which keeps the class name,
    // a safe-identifier `code` and stack FRAMES while dropping `message` and the
    // `pg` fields that name the schema. So an operator can still see what broke;
    // only the customer cannot.
    //
    // The reference is returned as `x-request-id` (design §22.9, §24.2) so support
    // can find the request in the log stream from what the customer quotes.
    req.log.error({ err: error }, "unhandled request error");
    return reply
      .code(500)
      .header(REQUEST_REFERENCE_HEADER, req.id)
      .send({
        error: "internal_error",
        message: "The request could not be completed.",
      });
  });
}

/**
 * The response header carrying the request reference (design §22.9, §24.2).
 *
 * ── THIS COMMENT USED TO SAY THE OPPOSITE, AND THE REASON MATTERS ────────────
 * It read: "Set on the 500 path, which is the class E.2 requires to carry a
 * reference. §24.2 also describes returning it on every response; that is a broader
 * observability change and is deliberately not made here."
 *
 * That deferral was correct at the time, and for a better reason than the comment
 * gave. Returning the header everywhere is only useful if the id can identify a
 * request, and Fastify's default `req.id` is a per-process counter (`req-1`) that
 * restarts on every boot — so shipping it would have made §24.2's promise ("quote
 * eight characters and support can find the exact request") false.
 *
 * Both halves are now done in `plugins/requestReference.ts`: a 12-character random id
 * with no digits, and an `onRequest` hook that returns it on EVERY response.
 *
 * The write below is therefore redundant rather than wrong, and it stays. The 500 path
 * is the one that returns no body a customer can act on, so it is where the reference
 * matters most, and two independent writes of the same value cost nothing.
 */
export const REQUEST_REFERENCE_HEADER = "x-request-id";

/**
 * True for a request whose body could not be read as its `content-type` declared.
 *
 * Matched on Fastify's `FST_ERR_CTP_*` prefix — the framework's own closed
 * vocabulary for content-type-parser failures — rather than on a hand-listed set
 * of five codes, so a parser error added by a future Fastify release is answered
 * with the portal envelope instead of escaping in the framework's.
 *
 * `error.validation` is included as depth: schema rejections are answered inside
 * the routes today (with `fields`), so this is unreachable from them, but if one
 * ever escapes, a 400 is the truthful answer and a 500 would not be.
 */
function isUnreadableRequestError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; validation?: unknown };
  if (typeof candidate.code === "string" && candidate.code.startsWith("FST_ERR_CTP_")) {
    return true;
  }
  return candidate.validation !== undefined;
}

/**
 * Unwraps a scope to the plain `customerId` the existing engines expect.
 *
 * Portal repository functions call this ONCE, at their own boundary, so the
 * unwrap points are few and greppable rather than scattered. Reaching for
 * `scope.customerId` directly works too and is equivalent; this exists so the
 * intent — "I am deliberately leaving the checked world here" — is legible at the
 * call site and in review.
 */
export function scopedCustomerId(scope: CustomerScope): string {
  return scope.customerId;
}

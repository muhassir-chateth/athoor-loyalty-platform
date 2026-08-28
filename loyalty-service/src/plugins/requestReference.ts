/**
 * The request reference — design §24.2, §22.9, Requirement 24.x.
 *
 * ── WHAT §24.2 ASKS FOR, AND WHAT WAS ACTUALLY THERE ─────────────────────────
 * §24.2: "the service returns it as an `x-request-id` response header, and the
 * client surfaces a shortened form in every Degraded_Section_State. A customer can
 * quote eight characters and support can find the exact request in the log stream."
 *
 * Two things stood between that and reality.
 *
 * The header was set on the 500 path only (`customerScope.ts`), so a customer
 * degraded by a 502, a 429, a 404 or a timeout received no reference at all. The
 * client already handled this correctly — `shortReference` hides the slot when the
 * id is absent — which is why the gap was invisible rather than broken-looking: the
 * feature was simply dark on almost every failure path.
 *
 * And Fastify's default `req.id` is a PER-PROCESS COUNTER: `req-1`, `req-2`. Shortened
 * by the client's `replace(/[^A-Za-z0-9]/g, "").slice(0, 8)` that becomes `req1` —
 * four characters, restarting from 1 on every boot. On a free-tier instance that
 * spins down when idle, `req1` would identify hundreds of different requests across
 * the log history. Returning it would have made §24.2's promise false: support would
 * find many requests, not the exact one.
 *
 * So the header alone was not the fix. The id has to be able to identify a request
 * before returning it means anything.
 *
 * ── THE SAME ID IS ALREADY A CUSTOMER-FACING GDPR REFERENCE ──────────────────
 * `routes/privacy.ts` builds the erasure reference as
 * `ERASE-${requestId.replace(/-/g, "").slice(0, 12).toUpperCase()}`. With the default
 * counter that is `ERASE-REQ1` — a legally significant handle for a GDPR erasure
 * request, colliding on every restart. That was live regardless of the header gap,
 * and it is the more serious half of this defect.
 *
 * ── WHY TWELVE LOWERCASE LETTERS ─────────────────────────────────────────────
 * The charset is not cosmetic. `observability/logCapture.gate.test.ts` fails the
 * build if a log line contains a secret-or-PII-shaped run, and `requestId` appears on
 * every log line. The forbidden shapes this must never accidentally form:
 *
 *   `\d{9,}`             a long digit run  -> impossible: there are NO digits
 *   `[0-9a-f]{32,}`      a hex digest      -> impossible: the id is 12 characters
 *   a UUID               8-4-4-4-12 hex    -> impossible: no digits, no hyphens
 *   `[A-Z]{1,2}\d...`    a UK postcode     -> impossible: lowercase, and no digits
 *
 * Every one of those is ruled out STRUCTURALLY rather than by luck. A mixed
 * alphanumeric id of this length would form a 9-digit run roughly once in 50,000
 * requests, and the build would fail on that request rather than on a code change —
 * which is the worst kind of flake to diagnose.
 *
 * Entropy: 26^12 ~ 9.5e16 for the full id, and 26^8 ~ 2.1e11 for the eight characters
 * a customer actually quotes. That is ample for "find the exact request".
 *
 * ── WHAT IS DELIBERATELY NOT DONE ────────────────────────────────────────────
 * No timestamp prefix, and no monotonic component. Both were considered: they would
 * make ids sortable, which is mildly convenient when reading a log stream. Both were
 * rejected because they introduce digits, which reopens the `\d{9,}` hazard above for
 * a benefit the log's own timestamp already provides.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** The response header carrying the reference (design §22.9, §24.2). */
export const REQUEST_ID_HEADER = "x-request-id";

/** Characters a generated id may contain. Lowercase letters only — see the header. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** Length of a generated id. The client shows the first 8; the log keeps all 12. */
export const REQUEST_ID_LENGTH = 12;

/**
 * A random request id.
 *
 * `randomBytes` once rather than `randomInt` twelve times: one call instead of
 * twelve, and the modulo bias it introduces is irrelevant here. This is a
 * correlation id, not a secret — nothing is authorised by guessing it, so a slightly
 * uneven distribution across 26 letters costs nothing. `randomInt` would be the right
 * choice if this value were ever a credential, and it is not.
 */
export function generateRequestId(): string {
  const bytes = randomBytes(REQUEST_ID_LENGTH);
  let out = "";
  for (let i = 0; i < REQUEST_ID_LENGTH; i += 1) {
    out += ID_ALPHABET[(bytes[i] as number) % ID_ALPHABET.length];
  }
  return out;
}

/**
 * Returns the reference on EVERY response (design §24.2).
 *
 * `onRequest`, matching `registerVersioning`'s pattern for exactly the same reason:
 * a header set at the start of the request is present however the response is
 * eventually produced — a handler, the not-found handler, the error handler, a
 * validation rejection or a serialisation failure. An `onSend` hook would also work
 * for the ordinary paths and would be easier to get subtly wrong on the others.
 *
 * The 500 handler in `auth/customerScope.ts` still sets the header itself. That is now
 * redundant rather than wrong, and it stays: the path that carries no body a customer
 * can act on is the one where the reference matters most, and two independent writes
 * of the same value cost nothing.
 */
export function registerRequestReference(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}

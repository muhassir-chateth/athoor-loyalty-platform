/**
 * THE LOG-FIELD ALLOWLIST (task 5.7, Requirements 2.8 and 23.7, design §24.3).
 *
 * WHY AN ALLOWLIST AND NOT A DENYLIST
 * -----------------------------------
 * A denylist fails OPEN. It excludes the fields somebody thought of, so the next
 * field somebody invents is permitted by default — and the failure is silent,
 * because a log line that contains one field too many looks exactly like a log
 * line that does not. §24.3 therefore specifies the opposite default: a
 * serialiser drops any key not on a fixed list, so `req.log.info({ customer })`
 * written a year from now emits nothing rather than an email address.
 *
 * The unknown key is the case this module is built around. Everything else —
 * nesting, error handling, the Fastify envelope — exists to stop that default
 * being bypassed by accident.
 *
 * WHAT IT ACTUALLY CLOSED
 * -----------------------
 * This is not hypothetical hardening. Fastify's own request logging emits
 * `req.url`, and `req.url` is the FULL request target including the query
 * string. On this service every proxied storefront request carries
 * `signature=…` and `logged_in_customer_id=…` in that query string, so before
 * this module every request wrote an App Proxy signature and a Shopify customer
 * id into the log stream — two of the entries §24.3 names as never-loggable.
 * {@link deriveFromEnvelope} is what removes them, by projecting Fastify's
 * `req`/`res`/`responseTime` onto the §24.3 vocabulary (`method`, `route`,
 * `statusCode`, `durationMs`) and then dropping the originals.
 *
 * WHERE IT IS ENFORCED
 * --------------------
 * {@link buildRedactingLoggerOptions} installs it at TWO pino choke points, and
 * the reason there are two is that neither alone is sufficient:
 *
 *   - `hooks.logMethod` intercepts the ARGUMENTS of every `log.*` call, on the
 *     root logger and — verified against pino 10 — on every per-request child
 *     logger Fastify derives from it. This is the only hook that can reach the
 *     MESSAGE, which matters because Fastify's default error log passes
 *     `err.message` as the message, and pino derives a message from an Error
 *     passed as the first argument. A payload filter cannot see either.
 *   - `formatters.log` filters the merged object pino is about to write. It runs
 *     BEFORE per-key serialisers (verified, not assumed), so it is the last
 *     point at which the whole payload is visible, and it catches anything that
 *     reaches pino without passing through `logMethod`.
 *
 * Both apply the same idempotent function, so double application is harmless.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY
 * -----------------------------------
 * pino's own envelope — `level`, `time`, `pid`, `hostname`, `msg`, and the
 * `requestId` binding Fastify attaches per request — does not pass through
 * `formatters.log` and is not part of the payload this module governs. None of
 * it is customer data: `requestId` is Fastify's per-request counter, which is
 * the correlation handle §24.2 is built on. It is named `requestId` rather than
 * pino's default `reqId` because §24.3 names it that way; see
 * {@link REQUEST_ID_LOG_LABEL}.
 */
import type { AuthChainTrace } from "../plugins/auth.js";

/**
 * The permitted keys, verbatim from design §24.3 ("**Allowed keys:**
 * `requestId`, `sessionRef`, `customerId`, `channel`, `source`, `route`,
 * `method`, `statusCode`, `durationMs`, `errorCode`, `upstream`,
 * `upstreamStatus`, `cacheHit`, `rateLimited`, `idempotencyOutcome`,
 * `coldStartMs`, `rowCount`, `pageSize`, `webhookId`, `jobName`, `attempt`"),
 * in the design's order so the two can be compared by eye.
 *
 * Exported so a test can assert this set EQUALS §24.3. Widening the log surface
 * then means editing a test that cites the design, which is the point: adding a
 * key here is a privacy decision, not a convenience.
 */
export const PERMITTED_LOG_KEYS = [
  "requestId",
  "sessionRef",
  "customerId",
  "channel",
  "source",
  "route",
  "method",
  "statusCode",
  "durationMs",
  "errorCode",
  "upstream",
  "upstreamStatus",
  "cacheHit",
  "rateLimited",
  "idempotencyOutcome",
  "coldStartMs",
  "rowCount",
  "pageSize",
  "webhookId",
  "jobName",
  "attempt",
] as const;

export type PermittedLogKey = (typeof PERMITTED_LOG_KEYS)[number];

const PERMITTED = new Set<string>(PERMITTED_LOG_KEYS);

/**
 * ESCAPE HATCH 1 of 2 — the `authChain` trace (`plugins/auth.ts`).
 *
 * WHY IT IS EXEMPT. It predates this module, it is the diagnostic that made a
 * production 401 attributable to the step that caused it, and it was designed
 * privacy-first: every field is a BOOLEAN except the route, a closed-set outcome
 * label, and a 4-character masked id suffix. Dropping it would delete a working
 * safety net to satisfy a rule it already honours.
 *
 * WHY IT IS STILL FILTERED. The exemption is for the KEY, not the SUBTREE.
 * `{ authChain: { email } }` must not slip through merely because its parent is
 * allowed, so the inner keys are allowlisted too, against exactly the fields the
 * trace declares today.
 *
 * The `satisfies` clause plus {@link AuthChainTraceKeysAreExhaustive} make this
 * a COMPILE-TIME gate in both directions: a name that is not a trace field fails
 * here, and adding a field to `AuthChainTrace` fails `tsc` until someone lists
 * it below — which forces the review that a silent auto-allow would skip.
 */
export const AUTH_CHAIN_TRACE_LOG_KEYS = [
  "route",
  "path",
  "signatureVerified",
  "loggedInCustomerIdPresent",
  "loggedInCustomerIdAnonymous",
  "maskedCustomerSuffix",
  "existingCustomerFound",
  "lazyFallbackWired",
  "enrollmentAttempted",
  "enrollmentSucceeded",
  "outcome",
] as const satisfies readonly (keyof AuthChainTrace)[];

const PERMITTED_AUTH_CHAIN = new Set<string>(AUTH_CHAIN_TRACE_LOG_KEYS);

/** Fails compilation with "Type 'X' does not satisfy the constraint 'never'" when a trace field is added but not reviewed above. */
type AssertNever<T extends never> = T;
export type AuthChainTraceKeysAreExhaustive = AssertNever<
  Exclude<keyof AuthChainTrace, (typeof AUTH_CHAIN_TRACE_LOG_KEYS)[number]>
>;

/**
 * ESCAPE HATCH 2 of 2 — a reshaped `err`.
 *
 * WHY IT IS EXEMPT. A genuine `5xx` must stay distinguishable from an expected
 * `401`. Those two are the same three-digit status to a log reader, and the
 * thing that tells them apart is the error's CLASS — `ScopeUnavailableError`
 * versus a Postgres or Shopify failure. Redacting that away would make the log
 * stream unable to answer "was this a real fault?", which is the question error
 * logs exist for.
 *
 * WHAT SURVIVES, AND WHY EACH IS SAFE:
 *   - `type` — the constructor name. Authored by us, or Node's.
 *   - `code` — a closed-vocabulary identifier (`ECONNREFUSED`, a five-character
 *     SQLSTATE, `identity_resolution_failed`). Accepted only if it MATCHES
 *     {@link SAFE_IDENTIFIER}, so a message cannot be smuggled through it.
 *   - `stack` — frame lines only.
 *
 * WHAT IS REMOVED, AND WHY IT HAS TO BE:
 *   - `message`. §24.3 forbids an upstream exception message outright, because it
 *     may embed a request body or a bearer value. A Postgres unique-violation
 *     message is the sharp case: it quotes the offending value, so a duplicate
 *     signup would log the customer's email address verbatim.
 *   - The FIRST LINE OF THE STACK, which is `"<type>: <message>"`. Keeping the
 *     stack while dropping `message` would otherwise remove nothing at all —
 *     the message would simply arrive by a different field. Only `    at …`
 *     frames are retained.
 *   - Everything else, including the fields a `pg` error carries — `detail`,
 *     `table`, `constraint`, `where`, `column` — which name our schema and often
 *     quote the offending value.
 */
const ERROR_LOG_KEY = "err" as const;

/** Every key this module may ever emit at the top level of a payload. */
const EMITTABLE_KEYS: readonly string[] = [
  ...PERMITTED_LOG_KEYS,
  "authChain",
  ERROR_LOG_KEY,
];

/**
 * The label Fastify uses for the per-request id binding. §24.3 names the field
 * `requestId`; pino's default is `reqId`. Bindings bypass `formatters.log`
 * (verified against pino 10 — the bindings formatter runs for the root `base`
 * only, not for `child()`), so this cannot be fixed by the filter and is set on
 * Fastify's `LogController` instead. See `app.ts`.
 */
export const REQUEST_ID_LOG_LABEL = "requestId";

/**
 * Substituted for a log message that was an exception's message.
 *
 * Deliberately says where to look instead: the error's class and code survive on
 * the `err` field, so the line remains diagnosable without carrying the text.
 */
export const REDACTED_ERROR_MESSAGE = "an error occurred; see err.type and errorCode";

/** Bounds so a permitted key cannot be used as a channel for bulk content. */
const MAX_STRING_LENGTH = 512;
const MAX_ROUTE_LENGTH = 200;
const MAX_STACK_FRAMES = 20;
const MAX_DEPTH = 4;

/** A short, closed-vocabulary identifier: enough for an error code, too little for a sentence. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A constructor name. */
const SAFE_TYPE_NAME = /^[A-Za-z0-9_$]{1,64}$/;
/** An HTTP method. */
const SAFE_HTTP_METHOD = /^[A-Z]{3,10}$/;
/** Only the frame lines of a stack — never the `"<type>: <message>"` header. */
const STACK_FRAME_LINE = /^\s+at\s/;

/**
 * A path segment that is an identifier rather than part of a route shape:
 * a number (an order number, a Shopify id), a UUID, or a long opaque token.
 *
 * Used ONLY on the fallback path, when Fastify could not give us a matched route
 * pattern — a `404`, or a log emitted before routing. §24.3 forbids logging an
 * order number, and `/v1/orders/6001234567` is an order number, so the raw path
 * is not loggable as-is.
 */
const OPAQUE_PATH_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,})$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reduce a request target to a loggable route.
 *
 * Prefers the MATCHED ROUTE PATTERN (`/v1/orders/:orderId`), which is a string
 * we authored and therefore contains no customer data by construction. Falls
 * back to the pathname with identifier-shaped segments masked, because a raw
 * path can be an order number and the query string is forbidden outright.
 */
function toLoggableRoute(routePattern: string | undefined, url: string | undefined): string | undefined {
  if (routePattern !== undefined && routePattern.length > 0) {
    return routePattern.slice(0, MAX_ROUTE_LENGTH);
  }
  if (url === undefined) {
    return undefined;
  }
  const masked = maskRequestPath(url);
  return masked.slice(0, MAX_ROUTE_LENGTH) || undefined;
}

/**
 * Reduce a request target to something loggable: drop the query string, then
 * mask the path segments that are identifiers rather than route shape.
 *
 * Exported because TWO callers need exactly this reduction and must not drift
 * apart. The second is the not-found handler in `app.ts`, which exists because
 * Fastify's built-in one logs `Route GET:<full target> not found` as a bare
 * MESSAGE — see {@link scrubRequestTargets}.
 */
export function maskRequestPath(url: string): string {
  // Everything from the first `?` is discarded before anything else looks at it:
  // the query string carries `signature` and `logged_in_customer_id`.
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname
    .split("/")
    .map((segment) => (segment.length > 0 && OPAQUE_PATH_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * Project Fastify's and pino's own log shapes onto the §24.3 vocabulary.
 *
 * Fastify names these fields differently from the design (`req`, `res`,
 * `responseTime`) and nests the useful values inside objects that also carry
 * forbidden ones. Filtering alone would leave two bad options: keep `req` and
 * keep leaking the query string, or drop `req` and lose request logging
 * entirely. Projection is the third: take `method`, `route`, `statusCode` and
 * `durationMs`, and let the originals be dropped by the allowlist like any other
 * unknown key.
 *
 * Returns only DERIVED values. The caller lets an explicit field of the same
 * name win, so a handler that logs its own `route` is never overwritten.
 */
function deriveFromEnvelope(source: Record<string, unknown>): Record<string, unknown> {
  const derived: Record<string, unknown> = {};

  const req = source["req"];
  if (isObject(req)) {
    const method = readString(req, "method");
    if (method !== undefined && SAFE_HTTP_METHOD.test(method)) {
      derived["method"] = method;
    }
    const routeOptions = req["routeOptions"];
    const route = toLoggableRoute(
      isObject(routeOptions) ? readString(routeOptions, "url") : undefined,
      readString(req, "url"),
    );
    if (route !== undefined) {
      derived["route"] = route;
    }
  }

  const res = source["res"];
  if (isObject(res)) {
    const statusCode = res["statusCode"];
    if (typeof statusCode === "number" && Number.isInteger(statusCode)) {
      derived["statusCode"] = statusCode;
    }
  }

  const responseTime = source["responseTime"];
  if (typeof responseTime === "number" && Number.isFinite(responseTime)) {
    derived["durationMs"] = Math.round(responseTime * 1000) / 1000;
  }

  // An error's code is the operationally useful half of §24.4's "Backend errors
  // → errorCode": it survives at the top level under the allowlisted name, so a
  // reader filtering on `errorCode` sees genuine faults alongside handled ones.
  const err = source[ERROR_LOG_KEY];
  if (isObject(err)) {
    const code = err["code"];
    if (typeof code === "string" && SAFE_IDENTIFIER.test(code)) {
      derived["errorCode"] = code;
    }
  }

  return derived;
}

/**
 * The closed shape of a loggable error. Handles a raw `Error`, a `pg`/Shopify
 * error carrying extra own properties, and an ALREADY-SANITISED object — the
 * last because this runs at two choke points and must be idempotent.
 */
function sanitiseError(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) && !(value instanceof Error)) {
    return undefined;
  }
  const source = value as Record<string, unknown> & { name?: unknown; stack?: unknown };
  const out: Record<string, unknown> = {};

  // `type` for a plain object (already sanitised), `name` for a real Error.
  const type = readString(source, "type") ?? readString(source, "name");
  if (type !== undefined && SAFE_TYPE_NAME.test(type)) {
    out["type"] = type;
  }

  const code = source["code"];
  if (typeof code === "string" && SAFE_IDENTIFIER.test(code)) {
    out["code"] = code;
  } else if (typeof code === "number" && Number.isInteger(code)) {
    out["code"] = code;
  }

  // Frames only. The header line is `"<type>: <message>"`, so keeping the stack
  // verbatim would reinstate the very message the `message` field was dropped
  // for. A multi-line message is removed by the same rule, because every line of
  // it fails the frame test.
  const stack = source["stack"];
  if (typeof stack === "string") {
    const frames = stack.split("\n").filter((line) => STACK_FRAME_LINE.test(line));
    if (frames.length > 0) {
      out["stack"] = frames.slice(0, MAX_STACK_FRAMES).join("\n");
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Filter the `authChain` trace against its own declared field set. */
function sanitiseAuthChain(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!PERMITTED_AUTH_CHAIN.has(key)) {
      continue;
    }
    const scalar = redactScalar(value[key]);
    if (scalar !== undefined) {
      out[key] = scalar;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Primitives that may be written verbatim, bounded so a key cannot carry bulk content. */
function redactScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
      return value.slice(0, MAX_STRING_LENGTH);
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "boolean":
      return value;
    default:
      return undefined;
  }
}

/**
 * Redact the value of an ALREADY-PERMITTED key.
 *
 * Recursion is the point of this function, and rule 2 of the task: a forbidden
 * value nested inside a permitted object must still be dropped, so the same
 * allowlist applies at every depth. `{ customerId: { email } }` therefore loses
 * the email rather than inheriting permission from its parent.
 *
 * A consequence worth stating: nesting under a permitted key is nearly always
 * lossy, because the inner names are hardly ever allowlisted names. That is the
 * intended pressure — §24.3 describes a flat vocabulary of scalars, and this
 * makes structured payloads uncomfortable rather than silently permitted.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  const scalar = redactScalar(value);
  if (scalar !== undefined || value === null) {
    return scalar;
  }
  if (!isObject(value) || depth > MAX_DEPTH) {
    return undefined;
  }
  // Cycles: a Fastify request object references itself through several fields.
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  // A Date under a permitted key would otherwise serialise to `{}`; an instant
  // is not customer data.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (Array.isArray(value)) {
    const items = value
      .map((item) => redactValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!PERMITTED.has(key)) {
      continue;
    }
    const redacted = redactValue(value[key], depth + 1, seen);
    if (redacted !== undefined) {
      out[key] = redacted;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Reduce a log payload to the §24.3 allowlist plus the two documented escape
 * hatches. Idempotent, so applying it at both choke points is safe.
 *
 * A non-object input yields `{}` — pino's `formatters.log` contract requires an
 * object, and "nothing recognisable" is the correct fail-closed answer.
 */
export function redactLogPayload(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    return {};
  }
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};

  // 1. The caller's own fields, allowlisted.
  for (const key of Object.keys(input)) {
    if (!PERMITTED.has(key)) {
      continue;
    }
    const value = redactValue(input[key], 1, seen);
    if (value !== undefined) {
      out[key] = value;
    }
  }

  // 2. Fields projected out of Fastify's envelope. Never overwrite an explicit
  //    value — a handler that logs its own `route` knows better than we do.
  for (const [key, value] of Object.entries(deriveFromEnvelope(input))) {
    if (out[key] === undefined) {
      out[key] = value;
    }
  }

  // 3. The escape hatches, each filtered against its own closed shape.
  const authChain = sanitiseAuthChain(input["authChain"]);
  if (authChain !== undefined) {
    out["authChain"] = authChain;
  }
  const err = sanitiseError(input[ERROR_LOG_KEY]);
  if (err !== undefined) {
    out[ERROR_LOG_KEY] = err;
  }

  return out;
}

/**
 * Sanitise the ARGUMENTS of one `log.*` call — the payload and the message.
 *
 * THE MESSAGE IS WHY THIS EXISTS. A payload filter cannot reach it, and two
 * routine paths put an exception's message there:
 *
 *   1. `log.error(err)` — pino derives the message from `err.message` itself,
 *      internally, after every hook has run. The only way to prevent that is to
 *      hand pino an explicit message so it has nothing to derive.
 *   2. `log.error({ req, res, err }, err.message)` — what Fastify's own default
 *      error handler does for every unhandled `5xx`. The message is passed
 *      explicitly, and it is the error's text.
 *
 * The rule applied is STRUCTURAL, not a search for bad words: a message that IS,
 * or CONTAINS, the message of an error in the same call is replaced. That also
 * covers the interpolated form (`` `save failed: ${err.message}` ``), which is
 * the shape a developer reaches for without thinking of it as logging an
 * upstream message.
 *
 * Author-written static messages — which is every other call site in this
 * service — are untouched.
 */
export function sanitiseLogArguments(args: readonly unknown[]): unknown[] {
  if (args.length === 0) {
    return [];
  }
  const [first, ...rest] = args;

  // `log.error(err)` / `log.error(err, "msg")`.
  if (first instanceof Error) {
    return [redactLogPayload({ [ERROR_LOG_KEY]: first }), safeMessage(rest[0], first.message)];
  }

  if (isObject(first)) {
    const embedded = first[ERROR_LOG_KEY];
    const embeddedMessage =
      embedded instanceof Error
        ? embedded.message
        : isObject(embedded)
          ? readString(embedded, "message")
          : undefined;
    const message = safeMessage(rest[0], embeddedMessage);
    // Trailing printf-style interpolation arguments are DROPPED, because their
    // values are unfiltered by construction — `log.info("customer %s", email)`
    // would otherwise defeat the allowlist through the message. No call site in
    // this service uses them, so nothing changes today; a future author sees a
    // literal `%s` and reaches for a structured field, which is what §24.3 wants
    // anyway.
    return message === undefined ? [redactLogPayload(first)] : [redactLogPayload(first), message];
  }

  // Message-only call — `log.info("…")`. This is the branch Fastify's not-found
  // logging arrives on, so it gets the same request-target reduction as any
  // other message rather than being treated as trusted because it is short.
  // Same reasoning as above for the dropped tail.
  return [typeof first === "string" ? safeMessage(first, undefined) : first];
}

/**
 * A `/`-leading run inside a free-text message — a request target, or a file
 * path. Stops at whitespace and at the quote characters a message tends to wrap
 * a URL in, so the surrounding sentence is preserved.
 */
const PATH_LIKE_RUN = /\/[^\s"'`,)]*/g;

/**
 * Remove request-target material from a log MESSAGE.
 *
 * WHY THIS EXISTS — a leak the log-capture gate (task 5.8) found in production
 * code, not in theory. Fastify's own not-found path logs
 *
 *     Route GET:/v1/orders/6012345678901/lines?…&logged_in_customer_id=…&signature=… not found
 *
 * as a bare `log.info(string)`. Three §24.3 rows in one line — the full query
 * string, the App Proxy signature and `logged_in_customer_id` — plus an order
 * number in the path. None of the existing protections reached it: the payload
 * allowlist saw no payload, and {@link safeMessage} left it alone because there
 * was no error in the same call whose text it could have been.
 *
 * `app.ts` now installs its own not-found handler, which is the fix at the
 * source. This is the fix at the CHOKE POINT, and it is the one that matters for
 * the next occurrence: an author writing `` log.info(`fetching ${req.url}`) ``
 * gets the same reduction without knowing this rule exists.
 *
 * The transformation is the one {@link maskRequestPath} already performs, so a
 * message and a `route` field cannot disagree about what is loggable. It is
 * idempotent, and a message with no `/` in it is returned unchanged — which is
 * every authored call site in this service.
 */
function scrubRequestTargets(message: string): string {
  if (!message.includes("/")) {
    return message;
  }
  return message.replace(PATH_LIKE_RUN, (run) => maskRequestPath(run));
}

/** Replace a message that carries an exception's text; leave an authored one alone. */
function safeMessage(candidate: unknown, errorMessage: string | undefined): string | undefined {
  if (typeof candidate !== "string") {
    // No message supplied. When an error is present pino would derive one from
    // it, so substitute rather than leave the field absent.
    return errorMessage === undefined ? undefined : REDACTED_ERROR_MESSAGE;
  }
  if (errorMessage === undefined || errorMessage.length === 0) {
    return scrubRequestTargets(candidate.slice(0, MAX_STRING_LENGTH));
  }
  // `length >= 4` avoids treating a trivially short error message ("no", "x")
  // as a substring match against an unrelated authored line.
  const carriesErrorText =
    candidate === errorMessage || (errorMessage.length >= 4 && candidate.includes(errorMessage));
  return carriesErrorText
    ? REDACTED_ERROR_MESSAGE
    : scrubRequestTargets(candidate.slice(0, MAX_STRING_LENGTH));
}

/** Every key {@link redactLogPayload} is capable of emitting. For tests. */
export function emittableLogKeys(): readonly string[] {
  return EMITTABLE_KEYS;
}

/** A sink for log lines. Structural, so a test can pass an array-backed collector. */
export interface LogDestination {
  write(line: string): void;
}

export interface RedactingLoggerOptions {
  level: string;
  /**
   * Where lines go. Omitted in production so pino writes to stdout, which is
   * what the hosting platform collects; supplied by a test that needs to assert
   * on what was actually written.
   */
  destination?: LogDestination;
}

/**
 * Build the pino options that make the allowlist unavoidable.
 *
 * Wired in `app.ts` so it governs the REAL logger rather than only the calls
 * that opt in — the difference between a rule and a gate. There is no
 * `redactedLog()` helper to remember to use, and no way to obtain an
 * unfiltered logger from the app.
 */
export function buildRedactingLoggerOptions(options: RedactingLoggerOptions): Record<string, unknown> {
  return {
    level: options.level,
    ...(options.destination ? { stream: options.destination } : {}),
    hooks: {
      // Choke point 1: arguments, including the message.
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void): void {
        method.apply(this, sanitiseLogArguments(args));
      },
    },
    formatters: {
      // Choke point 2: the merged payload, filtered again before it is written.
      log: (payload: Record<string, unknown>): Record<string, unknown> => redactLogPayload(payload),
    },
    serializers: {
      // Runs AFTER `formatters.log`, so it would be the one place able to
      // reintroduce an error's message. Pointed at the same closed shape so it
      // cannot.
      [ERROR_LOG_KEY]: (value: unknown): Record<string, unknown> => sanitiseError(value) ?? {},
    },
  };
}

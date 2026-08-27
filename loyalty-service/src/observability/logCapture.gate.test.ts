/**
 * THE LOG-CAPTURE GATE (task 5.8, Requirement 2.8, design §24.3 / §23.7 / §5.5).
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT THE 5.7 TEST AGAIN
 * -----------------------------------------------------
 * Task 5.7 built the allowlist serialiser and proved it correct: unit tests over
 * `redactLogPayload`, property tests over its inputs, and a handful of
 * end-to-end checks on two routes. All of that reasons about the FILTER.
 *
 * This is the gate design §5.5 names as the second, independent enforcement:
 * "a log-capture test over every portal endpoint including error paths". It
 * reasons about the SERVICE. The distinction matters because a correct filter
 * and a clean log stream are not the same claim — the filter can be perfect and
 * a value still reach the stream through a channel nobody filtered, which is
 * exactly what 5.7 discovered about `req.url` (the App Proxy `signature` and
 * `logged_in_customer_id` were being written on every proxied request). That was
 * found by looking at real output. So this test looks at real output, over every
 * route, in every status class.
 *
 * FOUR DECISIONS THAT DO THE WORK
 * -------------------------------
 * 1. IT CAPTURES THE REAL LOGGER. `buildApp` accepts a `logDestination`
 *    (task 5.7) precisely so a test can read what production would have written,
 *    through the same pino options production uses. Nothing here reimplements
 *    the filter: asserting against a reimplementation would prove something
 *    about the reimplementation.
 *
 * 2. IT ENUMERATES ROUTES RATHER THAN LISTING THEM, reusing the `onRoute`
 *    approach of `routeCensus.contract.test.ts` — installed before `ready()`, on
 *    an app built with a FULL dependency set, because nine of the most sensitive
 *    routes are conditionally registered and a `{}`-built app silently omits
 *    them. A portal endpoint added by tasks 8–15 is therefore covered the moment
 *    it registers, with no edit here. Path parameters are substituted with
 *    SINGLE-SEGMENT values for the reason that file records: a slash-bearing
 *    substitute turns the request into a 404 that never reaches the code under
 *    test.
 *
 * 3. IT CHECKS SHAPES, NOT FIELD NAMES. A list of forbidden field names protects
 *    against the fields somebody already thought of. §24.3's own list is a list
 *    of KINDS OF VALUE — an email address, a token, a full identifier — and a
 *    value's shape survives the rename of the field carrying it. So the scanner
 *    below looks for `@` in an address position, an `shpat_` prefix, a
 *    `postgres://` URI with credentials, a nine-digit run, a full UUID outside
 *    `customerId`, a UK postcode, a 32-character hex HMAC. Named bait values
 *    complement it for the kinds that have no distinctive shape (a discount
 *    code, a product title): every request carries them, so a leak of one is
 *    caught by exact match.
 *
 * 4. IT REFUSES TO BE VACUOUS. A capture harness that recorded nothing would
 *    satisfy every "must not appear" assertion, and a service that logged
 *    nothing useful would too. Both are worse than no gate, because they read as
 *    a pass. Three defences: every scenario asserts lines WERE captured; the run
 *    asserts the diagnostic vocabulary of §24.3/§24.4 IS present (`requestId`,
 *    `route`, `statusCode`, `durationMs`, `errorCode`, `authChain`, `err.type`);
 *    and the last describe block is a NEGATIVE CONTROL that runs the same
 *    capture and the same scanner against a Fastify app whose logger has no
 *    redaction, asserting the gate FIRES. If the scanner ever stops detecting,
 *    that control fails.
 *
 * THE BAIT IS SYNTHETIC AND SAYS SO
 * --------------------------------
 * Every planted value contains `FAKE_BAIT` or is drawn from a reserved test
 * range (Ofcom's `07700 900xxx` block, `example.com`). Nothing here is a real
 * credential, and a secret scan over this file will match on the bait prefixes
 * by design — that is what makes the assertions meaningful.
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import { InMemoryIdempotencyStore } from "../idempotency/store.js";
import {
  AUTH_CHAIN_TRACE_LOG_KEYS,
  emittableLogKeys,
  REDACTED_ERROR_MESSAGE,
} from "./logRedaction.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/* ------------------------------------------------------------------------- */
/* The bait. Every value is synthetic; see the header.                        */
/* ------------------------------------------------------------------------- */

/**
 * One value per row of §24.3's never-log table, planted in every channel a
 * request can carry data through: the query string, headers, the body, and the
 * message of an error thrown by a dependency.
 *
 * Each is unique and unusual, so a match is a leak rather than a coincidence.
 */
const BAIT = {
  email: "fake.bait.customer@example.invalid",
  firstName: "FAKEBAITFORENAME",
  lastName: "FAKEBAITSURNAME",
  phone: "+447700900123",
  address: "42 FAKE BAIT STREET",
  postcode: "SW1A 2AA",
  birthday: "1990-02-29",
  discountCode: "ATHOOR-FAKE-BAIT-DISCOUNT-9Q4Z",
  referralCode: "FAKEBAITREF77",
  idempotencyKey: "idem-FAKE-BAIT-KEY-7f3a91",
  adminToken: "shpat_FAKE_BAIT_ADMIN_TOKEN_0000000000000000",
  bearerToken: "shpca_FAKE_BAIT_BEARER_TOKEN_111111111111111",
  membershipKey: "shpss_FAKE_BAIT_MEMBERSHIP_KEY_22222222222222",
  cookie: "secure_customer_sig=FAKEBAITCOOKIE33333; _shopify_y=FAKEBAITY",
  databaseUrl: "postgres://bait_user:FAKE_BAIT_DB_PASSWORD@db.example.invalid:5432/loyalty",
  productTitle: "Fake Bait Oud Intense 50ml",
  orderNumber: "6012345678901",
  orderTotal: "£249.99",
  webhookBody: '{"customer":{"email":"fake.bait.customer@example.invalid"}}',
} as const;

/** Every bait value, for the exact-match sweep. */
const BAIT_VALUES: readonly string[] = Object.values(BAIT);

/**
 * A realistic Postgres unique-violation. THIS is the error that matters most:
 * `pg` quotes the offending value in both `message` and `detail`, so a duplicate
 * signup logs the customer's email address verbatim unless something stops it.
 * §24.3 forbids an upstream exception `message` for exactly this reason, and a
 * `5xx` is the path most likely to carry one.
 */
function pgUniqueViolation(at: string): Error {
  return Object.assign(
    new Error(
      `duplicate key value violates unique constraint "customers_email_key"\n` +
        `DETAIL:  Key (email)=(${BAIT.email}) already exists.`,
    ),
    {
      code: "23505",
      severity: "ERROR",
      detail: `Key (email)=(${BAIT.email}) already exists.`,
      table: "customers",
      schema: "public",
      constraint: "customers_email_key",
      where: `while inserting ${BAIT.firstName} ${BAIT.lastName}`,
      // The connection string a driver error sometimes carries.
      connectionString: BAIT.databaseUrl,
      calledAt: at,
    },
  );
}

/* ------------------------------------------------------------------------- */
/* The forbidden-shape scanner                                                */
/* ------------------------------------------------------------------------- */

interface Finding {
  /** Where in the record the value sat, e.g. `err.stack` or `msg`. */
  path: string;
  kind: string;
  sample: string;
}

/**
 * The shapes. Each maps to a row of §24.3, and each is proven to fire by
 * {@link SHAPE_SELF_TEST} — a regex that matches nothing is a gate that passes
 * for the wrong reason.
 */
const FORBIDDEN_SHAPES: readonly { kind: string; pattern: RegExp }[] = [
  // Email address (Requirement 2.8). `.invalid` and `.example` included by the
  // generic TLD class, so the bait is caught by the same rule as a real address.
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // Shopify credential prefixes: admin/custom-app tokens, shared secrets,
  // storefront and customer-account tokens.
  { kind: "shopify_credential", pattern: /\bshp(?:at|ss|pa|ca|us)_[A-Za-z0-9_]/i },
  // An HTTP authentication header value.
  { kind: "auth_scheme", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i },
  // A database URI, with or without inline credentials.
  { kind: "database_uri", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i },
  // Any URI carrying userinfo — the `user:password@host` form.
  { kind: "uri_credentials", pattern: /\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/ },
  // Query material: the parameter names §24.3 forbids, in `k=v` position.
  {
    kind: "query_material",
    pattern: /\b(?:signature|logged_in_customer_id|hmac|path_prefix)=/i,
  },
  // A Shopify session cookie.
  { kind: "cookie", pattern: /\b(?:secure_customer_sig|_shopify_[a-z]|_secure_session_id)=/i },
  // A full identifier: a 13-digit Shopify customer id, a 10+ digit order number,
  // a phone number. The masked 4-character suffix the auth trace emits is far
  // below this threshold and stays permitted, which is the intended split —
  // enough to attribute a request, not enough to name a person.
  { kind: "long_digit_run", pattern: /\d{9,}/ },
  // A UUID. Permitted ONLY under `customerId`, which §24.3 allows explicitly;
  // see the `customerId` exemption in `scanRecord`.
  {
    kind: "uuid",
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
  // A hex digest: an App Proxy signature, a webhook HMAC, a membership
  // signature. 32 hex characters is below the 64 of SHA-256 so a truncated one
  // is caught too, and above anything the permitted vocabulary emits.
  { kind: "hex_digest", pattern: /\b[0-9a-f]{32,}\b/i },
  // A UK postcode. Case-sensitive, so a lowercase file path in a stack frame
  // cannot masquerade as one.
  { kind: "uk_postcode", pattern: /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}\b/ },
  // An order total.
  { kind: "money", pattern: /(?:£|\bGBP\s?)\d/ },
];

/**
 * Proof that each shape matches something. Runs as a test, so a regex edited into
 * uselessness fails here rather than silently widening the gate.
 */
const SHAPE_SELF_TEST: readonly { kind: string; sample: string }[] = [
  { kind: "email", sample: `contacted ${BAIT.email} about it` },
  { kind: "shopify_credential", sample: BAIT.adminToken },
  { kind: "auth_scheme", sample: `Bearer ${BAIT.bearerToken}` },
  { kind: "database_uri", sample: BAIT.databaseUrl },
  { kind: "uri_credentials", sample: BAIT.databaseUrl },
  { kind: "query_material", sample: "path=/x&signature=abc&logged_in_customer_id=1" },
  { kind: "cookie", sample: BAIT.cookie },
  { kind: "long_digit_run", sample: `order ${BAIT.orderNumber}` },
  { kind: "uuid", sample: `customer ${LOCAL_CUSTOMER_ID}` },
  { kind: "hex_digest", sample: `sig ${"a1b2c3d4".repeat(8)}` },
  { kind: "uk_postcode", sample: `delivered to ${BAIT.postcode}` },
  { kind: "money", sample: `total ${BAIT.orderTotal}` },
];

/** A value that is nothing but a UUID — the permitted form of `customerId`. */
const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * pino's own envelope. Machine metadata, not payload: `level` and `time` are
 * pino's, `pid` and `hostname` describe the PROCESS. They do not pass through
 * `formatters.log` and §24.3 does not govern them.
 *
 * `hostname` is excluded from VALUE scanning for a stated reason: on a developer
 * machine it is the operator's computer name (`…-MacBook-Pro.local`), which can
 * contain a person's name and would otherwise trip the shape scan on a fact
 * about the machine rather than about a customer. In production it is the
 * platform's container id. The key-allowlist check below still applies, so
 * nothing else can hide under these four names.
 */
const PINO_ENVELOPE_KEYS = ["level", "time", "pid", "hostname"] as const;
const UNSCANNED_ENVELOPE_KEYS = new Set<string>(PINO_ENVELOPE_KEYS);

/** Every key any captured record may legitimately carry, at any depth. */
const PERMITTED_RECORD_KEYS = new Set<string>([
  ...emittableLogKeys(),
  ...PINO_ENVELOPE_KEYS,
  "msg",
]);
/** The two documented escape hatches' inner shapes. */
const PERMITTED_AUTH_CHAIN_KEYS = new Set<string>(AUTH_CHAIN_TRACE_LOG_KEYS);
const PERMITTED_ERROR_KEYS = new Set<string>(["type", "code", "stack"]);

/** Walk a parsed record, collecting every forbidden shape. */
function scanRecord(record: unknown, pathPrefix = ""): Finding[] {
  const findings: Finding[] = [];

  const visit = (value: unknown, path: string, keyName: string): void => {
    if (typeof value === "number") {
      // A full identifier logged as a number rather than a string. `time` and
      // `pid` are the envelope; nothing in the permitted vocabulary is this big.
      if (!UNSCANNED_ENVELOPE_KEYS.has(keyName) && Number.isInteger(value) && Math.abs(value) >= 1e9) {
        findings.push({ path, kind: "long_digit_run", sample: String(value) });
      }
      return;
    }
    if (typeof value === "string") {
      if (UNSCANNED_ENVELOPE_KEYS.has(keyName)) {
        return;
      }
      // §24.3 permits `customerId` — an internal UUID, meaningless outside our
      // database and absent from every customer-facing surface.
      //
      // The exemption is CONDITIONAL on the value actually being a UUID, which
      // makes it a check rather than a hole: a `customerId` holding a 13-digit
      // Shopify id, an email address or anything else is still a finding. Scoped
      // to the whole value because a UUID's own digit groups can be long enough
      // to trip the full-identifier rule.
      if (keyName === "customerId" && WHOLE_UUID.test(value)) {
        return;
      }
      for (const { kind, pattern } of FORBIDDEN_SHAPES) {
        const match = pattern.exec(value);
        if (match) {
          findings.push({ path, kind, sample: match[0].slice(0, 80) });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, keyName));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, path === "" ? key : `${path}.${key}`, key);
      }
    }
  };

  visit(record, pathPrefix, "");
  return findings;
}

/** Every key present anywhere in a record, as `path` → `key`. */
function collectKeys(value: unknown, path = ""): { path: string; key: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const out: { path: string; key: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    out.push({ path: childPath, key });
    out.push(...collectKeys(child, childPath));
  }
  return out;
}

/**
 * The closed-vocabulary check, and the reason a FUTURE forbidden field fails this
 * test without anyone editing it: the allowlist is closed, so any key that is not
 * on it is a finding regardless of what it is called or what it holds.
 */
function unexpectedKeys(record: Record<string, unknown>): string[] {
  return collectKeys(record)
    .filter(({ path, key }) => {
      if (path.startsWith("authChain.")) return !PERMITTED_AUTH_CHAIN_KEYS.has(key);
      if (path.startsWith("err.")) return !PERMITTED_ERROR_KEYS.has(key);
      return !PERMITTED_RECORD_KEYS.has(key);
    })
    .map(({ path }) => path);
}

/** Exact-match sweep for the kinds that have no distinctive shape. */
function baitHits(output: string): string[] {
  return BAIT_VALUES.filter((value) => output.includes(value));
}

/* ------------------------------------------------------------------------- */
/* Capture harness                                                            */
/* ------------------------------------------------------------------------- */

interface Capture {
  app: FastifyInstance;
  lines: string[];
  records: () => Record<string, unknown>[];
}

/**
 * A dependency stand-in that throws a bait-bearing Postgres error however it is
 * reached — `deps.method()`, `deps.repo.append()`, any depth. Recursion matters
 * because the real dependencies are nested (`redeemDeps.ledgerRepo.append`), and
 * a one-level fake would produce a bland `TypeError` instead of the driver error
 * that carries an email address.
 */
function leakyDependency(path: string): unknown {
  const thrower = function leak(): never {
    throw pgUniqueViolation(path);
  };
  return new Proxy(thrower, {
    get(_target, prop) {
      // Not a thenable, and no exotic protocol hooks — an `await` on this must
      // reject through `apply`, not hang on a fake `then`.
      if (typeof prop === "symbol" || prop === "then" || prop === "catch") {
        return undefined;
      }
      return leakyDependency(`${path}.${String(prop)}`);
    },
    apply() {
      throw pgUniqueViolation(path);
    },
  });
}

/**
 * Build the app with a FULL dependency set and a log collector.
 *
 * `resolveCustomer` decides whether the App Proxy path can resolve an identity:
 * the unauthenticated scenarios want it empty, the authenticated ones want the
 * mapping. The idempotency store is FUNCTIONAL rather than leaky, because a
 * throwing store would answer every state-changing request with a 500 raised in
 * a scope preHandler — before the route's own limiter and handler — and the 429
 * and validation paths would never be reached.
 */
function capture(options: { resolveCustomer: boolean; extra?: (app: FastifyInstance) => void }): Capture {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
    ADMIN_AUTH_SECRET: BAIT.adminToken,
    MEMBERSHIP_SIGNING_KEY: BAIT.membershipKey,
  } as NodeJS.ProcessEnv);

  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leak = (name: string): any => leakyDependency(name);

  const app = buildApp(config, {
    customerResolver: new InMemoryCustomerResolver(
      options.resolveCustomer ? { [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID } : {},
    ),
    idempotencyStore: new InMemoryIdempotencyStore(),
    balanceSource: leak("balanceSource"),
    historySource: leak("historySource"),
    entitlementResolver: leak("entitlementResolver"),
    fragranceProfileDataSource: leak("fragranceProfileDataSource"),
    portalVisitRecorder: leak("portalVisitRecorder"),
    preferenceStore: leak("preferenceStore"),
    recentlyViewedRecorder: leak("recentlyViewedRecorder"),
    deviceTokenStore: leak("deviceTokenStore"),
    membershipCredentialService: leak("membershipCredentialService"),
    redeemDeps: leak("redeemDeps"),
    referralDeps: leak("referralDeps"),
    adminAuthenticator: leak("adminAuthenticator"),
    adminAdjustmentService: leak("adminAdjustmentService"),
    adminCustomerLedgerSource: leak("adminCustomerLedgerSource"),
    fraudReviewSource: leak("fraudReviewSource"),
    adminOperationsService: leak("adminOperationsService"),
    analyticsService: leak("analyticsService"),
    adminBenefitRequestService: leak("adminBenefitRequestService"),
    logDestination: { write: (line) => lines.push(line.trim()) },
  });

  options.extra?.(app);

  return {
    app,
    lines,
    records: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface Route {
  method: string;
  url: string;
}

/**
 * Single-segment substitutes for path parameters. A slash-bearing value would
 * make the path span extra segments, Fastify would answer 404, and the route
 * would silently go untested while appearing covered — the trap
 * `routeCensus.contract.test.ts` documents.
 */
const PARAM_VALUES: Record<string, string> = {
  ":token": "device-token-1",
  ":customerId": LOCAL_CUSTOMER_ID,
  ":id": "9999195275603",
  ":key": "perk",
  // The BAIT order number, not a placeholder. `GET /v1/orders/:orderId` accepts
  // `^\d{1,20}$` only, so the fallback `"x"` would be rejected as a malformed
  // reference and the handler's real paths — including the `502` it logs when
  // Shopify is unreachable — would go untested while appearing covered. Using the
  // bait also makes this gate assert what §24.3 actually forbids on this route:
  // an order number must never reach a log line.
  ":orderId": BAIT.orderNumber,
};

function concretise(url: string): string {
  return url
    .split("/")
    .map((segment) => (segment.startsWith(":") ? (PARAM_VALUES[segment] ?? "x") : segment))
    .join("/");
}

/**
 * The floor on the enumerated surface, as observed on the branch that introduced
 * this gate: 32 non-HEAD routes. Adding an endpoint raises the real count and
 * this still passes; REMOVING one — or failing to forward a dependency, so nine
 * conditionally-registered routes quietly vanish — fails here, which is the
 * regression the number is for.
 */
const ENUMERATED_ROUTE_FLOOR = 32;

/**
 * Enumerate what Fastify actually registered; the hook must precede `ready()`,
 * because `buildApp` defers the routers through `app.register` and the URLs are
 * only fully prefixed once they are resolved.
 *
 * HEAD is Fastify's derived twin of a GET and has no body to assert on. Nothing
 * else is filtered out — in particular `POST /webhooks/shopify` is INCLUDED,
 * even though it is not a portal endpoint, because "raw webhook body" is its own
 * row in §24.3 and that is the only route that ever holds one.
 */
async function enumerated(cap: Capture): Promise<Route[]> {
  const routes: Route[] = [];
  cap.app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const method of methods) routes.push({ method, url: r.url });
  });
  await cap.app.ready();
  return routes.filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS");
}

/** Sign a query, so bait planted in it survives signature verification. */
function signed(params: Record<string, string>): string {
  const withTimestamp: QueryParams = {
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...params,
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withTimestamp)) {
    if (typeof value === "string") search.set(key, value);
  }
  search.set("signature", computeAppProxySignature(withTimestamp, APP_PROXY_SECRET));
  return search.toString();
}

/**
 * The query string of a real proxied request, with bait added as SIGNED
 * parameters so the request still verifies. Shopify would not send these; the
 * point is that whatever arrives in the query string must not be logged, and
 * `req.url` carries all of it.
 */
function baitQuery(customerId: string): string {
  return signed({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: customerId,
    path_prefix: "/apps/loyalty",
    email: BAIT.email,
    referral: BAIT.referralCode,
    discount: BAIT.discountCode,
  });
}

/** Bait in every header a client controls. */
const BAIT_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  cookie: BAIT.cookie,
  "idempotency-key": BAIT.idempotencyKey,
  "x-shopify-hmac-sha256": "a1b2c3d4".repeat(8),
  "x-forwarded-for": "203.0.113.7",
  "user-agent": `bait/1.0 (${BAIT.firstName})`,
};

/** Bait in every body field a portal write could plausibly accept. */
const BAIT_BODY: Record<string, unknown> = {
  email: BAIT.email,
  firstName: BAIT.firstName,
  lastName: BAIT.lastName,
  phone: BAIT.phone,
  address1: BAIT.address,
  zip: BAIT.postcode,
  birthday: BAIT.birthday,
  month: 2,
  day: 29,
  code: BAIT.referralCode,
  discountCode: BAIT.discountCode,
  rewardId: BAIT.productTitle,
  idempotencyKey: BAIT.idempotencyKey,
  orderId: BAIT.orderNumber,
  total: BAIT.orderTotal,
  webhook: BAIT.webhookBody,
};

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Assert a captured stream is clean, and say precisely what was wrong when it is
 * not — a gate that fails without naming the offending path costs more time than
 * it saves.
 */
function assertStreamClean(cap: Capture, scenario: string): Record<string, unknown>[] {
  const output = cap.lines.join("\n");
  const records = cap.records();

  // NOT VACUOUS: something was actually captured.
  expect(cap.lines.length, `${scenario}: no log lines were captured at all`).toBeGreaterThan(0);

  const hits = baitHits(output);
  expect(hits, `${scenario}: planted values reached the log stream`).toEqual([]);

  const shapeFindings = records.flatMap((record, index) =>
    scanRecord(record).map((f) => `line ${index} ${f.path}: ${f.kind} (${f.sample})`),
  );
  expect(shapeFindings, `${scenario}: forbidden value shapes reached the log stream`).toEqual([]);

  const keyFindings = records.flatMap((record, index) =>
    unexpectedKeys(record).map((path) => `line ${index}: ${path}`),
  );
  expect(keyFindings, `${scenario}: keys outside the §24.3 allowlist reached the log stream`).toEqual(
    [],
  );

  // §24.3: correlation to a customer is `customerId` PLUS `requestId`, never a
  // customer identifier standing alone in the stream.
  const orphans = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => "customerId" in record && !("requestId" in record))
    .map(({ index }) => `line ${index}`);
  expect(orphans, `${scenario}: customerId appeared without requestId`).toEqual([]);

  return records;
}

/* ------------------------------------------------------------------------- */

describe("the forbidden-shape scanner itself", () => {
  it("detects every shape it claims to detect", () => {
    for (const { kind, sample } of SHAPE_SELF_TEST) {
      const findings = scanRecord({ msg: sample });
      expect(
        findings.map((f) => f.kind),
        `shape "${kind}" did not fire on its own sample`,
      ).toContain(kind);
    }
  });

  it("covers every declared shape with a sample, so none is untested", () => {
    expect([...new Set(SHAPE_SELF_TEST.map((s) => s.kind))].sort()).toEqual(
      [...new Set(FORBIDDEN_SHAPES.map((s) => s.kind))].sort(),
    );
  });

  it("permits a UUID under customerId and nowhere else", () => {
    expect(scanRecord({ customerId: LOCAL_CUSTOMER_ID })).toEqual([]);
    expect(scanRecord({ source: LOCAL_CUSTOMER_ID }).map((f) => f.kind)).toContain("uuid");
  });

  it("permits the masked 4-character suffix the auth trace emits", () => {
    // The existing diagnostic must survive: it is what made a production 401
    // attributable, and 4 characters is far below the identifier threshold.
    expect(scanRecord({ authChain: { maskedCustomerSuffix: "6563", route: "/v1/balance" } })).toEqual(
      [],
    );
  });

  it("flags an unknown key at any depth", () => {
    expect(unexpectedKeys({ requestId: "req-1", customer: { email: BAIT.email } })).toContain(
      "customer",
    );
    expect(unexpectedKeys({ authChain: { email: BAIT.email } })).toContain("authChain.email");
    expect(unexpectedKeys({ err: { message: "boom" } })).toContain("err.message");
  });
});

describe("log capture over every /v1 endpoint", () => {
  it("enumerates the real route surface, including the dependency-gated routes", async () => {
    const cap = capture({ resolveCustomer: false });
    try {
      const routes = await enumerated(cap);
      const urls = new Set(routes.map((r) => r.url));
      // The routes that vanish when a dependency is not forwarded. If wiring
      // regresses they disappear from the run, and this gate would quietly cover
      // less than it claims.
      for (const required of [
        "/v1/balance",
        "/v1/history",
        "/v1/redeem",
        "/v1/profile",
        "/v1/profile/favourites",
        "/v1/profile/wishlist",
        "/v1/profile/wishlist/reconcile",
        "/v1/profile/recently-viewed",
        "/v1/referral",
        "/v1/benefits",
        "/v1/devices",
        "/v1/membership-card",
        // The only route that ever holds a raw webhook body (§24.3).
        "/webhooks/shopify",
      ]) {
        expect(urls.has(required), `route ${required} did not register`).toBe(true);
      }
      expect(routes.length).toBeGreaterThanOrEqual(ENUMERATED_ROUTE_FLOOR);
    } finally {
      await cap.app.close();
    }
  });

  it("logs nothing forbidden for an unauthenticated request carrying bait in every header", async () => {
    const cap = capture({ resolveCustomer: false });
    const routes = await enumerated(cap);
    const statuses = new Set<number>();

    for (const route of routes) {
      const res = await cap.app.inject({
        method: route.method as "GET",
        url: concretise(route.url),
        headers: {
          ...BAIT_HEADERS,
          // A bearer token takes precedence in `resolveAuthContext`, so this is
          // the scenario that exercises the bearer-verification-failure path
          // §24.4 lists — the one place a token is most likely to be logged.
          authorization: `Bearer ${BAIT.bearerToken}`,
        },
        ...(BODY_METHODS.has(route.method) ? { payload: BAIT_BODY } : {}),
      });
      statuses.add(res.statusCode);
    }
    await cap.app.close();

    assertStreamClean(cap, "unauthenticated with header bait");
    // The scenario really did reject: had everything answered 200 the error
    // paths would not have been exercised.
    expect([...statuses].some((s) => s === 401)).toBe(true);
  });

  it("logs no signature, no query string and no query bait for a signed anonymous request", async () => {
    const cap = capture({ resolveCustomer: false });
    const routes = await enumerated(cap);
    const query = baitQuery("0");
    const signature = new URLSearchParams(query).get("signature") ?? "";

    for (const route of routes) {
      await cap.app.inject({
        method: route.method as "GET",
        url: `${concretise(route.url)}?${query}`,
        headers: BAIT_HEADERS,
        ...(BODY_METHODS.has(route.method) ? { payload: BAIT_BODY } : {}),
      });
    }
    await cap.app.close();

    const records = assertStreamClean(cap, "signed anonymous with query bait");
    const output = cap.lines.join("\n");
    // Named explicitly as well as by shape: this is the leak 5.7 actually found.
    expect(signature.length).toBeGreaterThan(0);
    expect(output).not.toContain(signature);
    expect(output).not.toContain("logged_in_customer_id");
    expect(output).not.toContain("myathoorlondon");
    // The stream is still readable — the 401 remains attributable.
    expect(records.some((r) => r["authChain"] !== undefined)).toBe(true);
  });

  it("logs nothing forbidden when the signature is invalid", async () => {
    const cap = capture({ resolveCustomer: false });
    const routes = await enumerated(cap);
    // A valid signature over DIFFERENT parameters than the ones sent.
    const tampered = baitQuery(SHOPIFY_CUSTOMER_ID).replace(SHOPIFY_CUSTOMER_ID, "1234567890123");

    for (const route of routes) {
      await cap.app.inject({
        method: route.method as "GET",
        url: `${concretise(route.url)}?${tampered}`,
        headers: BAIT_HEADERS,
        ...(BODY_METHODS.has(route.method) ? { payload: BAIT_BODY } : {}),
      });
    }
    await cap.app.close();

    const records = assertStreamClean(cap, "invalid signature with query bait");
    expect(
      records.some((r) => r["errorCode"] === "app_proxy_signature_invalid" ||
        (r["authChain"] as Record<string, unknown> | undefined)?.["outcome"] ===
          "app_proxy_signature_invalid"),
      "the signature failure was not recorded at all",
    ).toBe(true);
  });

  it("logs nothing forbidden when an authenticated request faults in the driver", async () => {
    // THE 500 PATH, and the sharpest case in the whole gate: identity resolves,
    // the handler runs, and the dependency throws a Postgres unique violation
    // whose message and `detail` quote a customer's email address.
    const cap = capture({
      resolveCustomer: true,
      extra: (app) => {
        // Makes the `customerId` rule non-vacuous: a legitimate, request-scoped
        // log line carrying the internal UUID §24.3 permits.
        app.get("/__bait/customer-log", async (req) => {
          req.log.info({ customerId: LOCAL_CUSTOMER_ID, source: "app_proxy" }, "portal read");
          return { ok: true };
        });
      },
    });
    const routes = await enumerated(cap);
    const query = baitQuery(SHOPIFY_CUSTOMER_ID);
    const statuses = new Set<number>();

    for (const route of routes) {
      const res = await cap.app.inject({
        method: route.method as "GET",
        url: `${concretise(route.url)}?${query}`,
        headers: { ...BAIT_HEADERS, "idempotency-key": BAIT.idempotencyKey },
        ...(BODY_METHODS.has(route.method) ? { payload: BAIT_BODY } : {}),
      });
      statuses.add(res.statusCode);
    }
    await cap.app.inject({ method: "GET", url: "/__bait/customer-log" });
    await cap.app.close();

    const records = assertStreamClean(cap, "authenticated with a faulting driver");

    // A genuine fault was actually reached, not skipped.
    expect([...statuses], "no 5xx was produced, so the error path was not exercised").toContain(500);

    // RULE 2: the gate must not be satisfiable by logging nothing useful. A real
    // fault stays diagnosable — its class and code survive redaction — while its
    // message does not.
    const errorLines = records.filter((r) => r["level"] === 50);
    expect(errorLines.length, "no error-level line was written for a 5xx").toBeGreaterThan(0);
    expect(errorLines.some((r) => r["errorCode"] === "23505")).toBe(true);
    expect(
      errorLines.some((r) => (r["err"] as Record<string, unknown> | undefined)?.["type"] === "Error"),
    ).toBe(true);
    expect(errorLines.some((r) => r["msg"] === REDACTED_ERROR_MESSAGE)).toBe(true);
    expect(errorLines.some((r) => typeof (r["err"] as Record<string, unknown>)["stack"] === "string")).toBe(
      true,
    );

    // NOT VACUOUS: the permitted key was genuinely exercised alongside requestId.
    const withCustomer = records.filter((r) => "customerId" in r);
    expect(withCustomer.length, "no line carried customerId, so its rule was vacuous").toBeGreaterThan(
      0,
    );
    expect(withCustomer.every((r) => "requestId" in r)).toBe(true);
  });

  it("logs nothing forbidden on the validation, rate-limit and unmatched-path errors", async () => {
    const cap = capture({ resolveCustomer: true });
    await enumerated(cap);
    const query = baitQuery(SHOPIFY_CUSTOMER_ID);

    // 400 — a state-changing request with no Idempotency-Key.
    const missingKey = await cap.app.inject({
      method: "POST",
      url: `/v1/redeem?${query}`,
      headers: { "content-type": "application/json", cookie: BAIT.cookie },
      payload: BAIT_BODY,
    });

    // 400 — a malformed body. Fastify's JSON parser error is one of the few
    // messages derived from the request payload itself.
    const malformed = await cap.app.inject({
      method: "POST",
      url: `/v1/redeem?${query}`,
      headers: { "content-type": "application/json", "idempotency-key": BAIT.idempotencyKey },
      payload: `{"email":"${BAIT.email}", "oops"`,
    });

    // 415 — a form-encoded write, which the portal must never send.
    const formEncoded = await cap.app.inject({
      method: "POST",
      url: `/v1/redeem?${query}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": BAIT.idempotencyKey,
      },
      payload: `email=${encodeURIComponent(BAIT.email)}&code=${BAIT.discountCode}`,
    });

    // 429 — the redemption limiter is 10 per 60s per customer, so the eleventh
    // distinct key is rejected before the handler runs.
    const limited: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await cap.app.inject({
        method: "POST",
        url: `/v1/redeem?${query}`,
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${BAIT.idempotencyKey}-${attempt}`,
        },
        payload: { rewardId: "reward_100", idempotencyKey: `${BAIT.idempotencyKey}-${attempt}` },
      });
      limited.push(res.statusCode);
    }

    // 404 — an unmatched path carrying an order number and a full query string.
    // This is the ONLY path where the serialiser cannot use a matched route
    // pattern, so it must mask the identifier segments itself.
    const notFound = await cap.app.inject({
      method: "GET",
      url: `/v1/orders/${BAIT.orderNumber}/lines?${query}`,
      headers: BAIT_HEADERS,
    });

    await cap.app.close();
    const records = assertStreamClean(cap, "validation, rate-limit and unmatched-path errors");

    expect(missingKey.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect([400, 415]).toContain(formEncoded.statusCode);
    expect(limited).toContain(429);
    expect(notFound.statusCode).toBe(404);

    // Every status class really was represented in what was captured, so the
    // clean-stream assertion above covered them.
    const captured = new Set(records.map((r) => r["statusCode"]).filter((s) => typeof s === "number"));
    for (const status of [400, 429, 404]) {
      expect(captured, `status ${status} produced no captured log line`).toContain(status);
    }
    // The 404's route was masked rather than carrying the order number.
    const notFoundLine = records.find((r) => r["statusCode"] === 404);
    expect(String(notFoundLine?.["route"] ?? "")).not.toContain(BAIT.orderNumber);
    expect(String(notFoundLine?.["route"] ?? "")).toContain(":id");
  });

  it("keeps §24.3's diagnostic vocabulary present across the whole run", async () => {
    // The counterweight to every "must not appear" assertion above. A silent
    // service would satisfy all of them, so the fields §24.2/§24.4 rely on for
    // correlation and severity are asserted PRESENT.
    const cap = capture({ resolveCustomer: true });
    await enumerated(cap);
    const query = baitQuery(SHOPIFY_CUSTOMER_ID);

    await cap.app.inject({ method: "GET", url: "/v1/version" });
    await cap.app.inject({ method: "GET", url: `/v1/balance?${query}` });
    await cap.app.inject({ method: "GET", url: "/v1/balance" });
    await cap.app.close();

    const records = assertStreamClean(cap, "diagnostic vocabulary");
    const present = new Set(records.flatMap((r) => Object.keys(r)));
    for (const key of ["requestId", "method", "route", "statusCode", "durationMs", "authChain"]) {
      expect(present, `§24.3 field ${key} is absent from the whole run`).toContain(key);
    }
    expect(records.some((r) => r["route"] === "/v1/balance")).toBe(true);
    expect(records.some((r) => r["statusCode"] === 200)).toBe(true);
  });
});

describe("the leak this gate found, and both halves of its fix", () => {
  /**
   * Kept as its own block rather than folded into the sweep above, because a
   * regression here is a specific, named privacy defect and deserves a failure
   * that says so.
   *
   * WHAT WAS WRONG. Fastify's built-in not-found path logged
   * `Route GET:<full target> not found` as a bare message and echoed the same
   * target in the response body. On a proxied storefront the target carries
   * `signature`, `logged_in_customer_id`, and often an order number — four §24.3
   * rows, on every mistyped or stale portal URL.
   */
  it("writes no query string, signature or order number for an unmatched route", async () => {
    const cap = capture({ resolveCustomer: true });
    await enumerated(cap);
    const query = baitQuery(SHOPIFY_CUSTOMER_ID);
    const signature = new URLSearchParams(query).get("signature") ?? "";

    const res = await cap.app.inject({
      method: "GET",
      url: `/v1/orders/${BAIT.orderNumber}/lines?${query}`,
    });
    await cap.app.close();

    const records = assertStreamClean(cap, "unmatched route");
    const line = records.find((r) => r["msg"] === "route not found");

    expect(res.statusCode).toBe(404);
    expect(line, "the 404 was not recorded at all").toBeDefined();
    // Still diagnosable: which method, roughly where, and what happened.
    expect(line).toMatchObject({ method: "GET", route: "/v1/orders/:id/lines", statusCode: 404 });
    expect(signature.length).toBeGreaterThan(0);
    const output = cap.lines.join("\n");
    expect(output).not.toContain(signature);
    expect(output).not.toContain(BAIT.orderNumber);
    expect(output).not.toContain("logged_in_customer_id");

    // The body no longer repeats the request target either — a signature echoed
    // back is not a leak to its own sender, but it does not belong in a body the
    // client may log, screenshot or paste into a support ticket.
    const body = res.json() as { error?: string; message?: string };
    expect(body.error).toBe("not_found");
    expect(JSON.stringify(body)).not.toContain(signature);
    expect(JSON.stringify(body)).not.toContain(BAIT.orderNumber);
  });

  it("applies the same reduction to a request target a handler puts in a message", async () => {
    // THE CHOKE-POINT HALF of the fix, and the reason it exists: the not-found
    // handler fixes the one occurrence we found, and this fixes the next one.
    const cap = capture({
      resolveCustomer: true,
      extra: (app) => {
        app.get("/__bait/interpolated", async (req) => {
          // The shape an author reaches for without thinking of it as logging a
          // secret. It is: on this service the query string is authentication
          // material.
          req.log.info(`fetching ${req.url} for the dashboard`);
          return { ok: true };
        });
      },
    });
    await enumerated(cap);
    const query = baitQuery(SHOPIFY_CUSTOMER_ID);
    const signature = new URLSearchParams(query).get("signature") ?? "";

    await cap.app.inject({ method: "GET", url: `/__bait/interpolated?${query}` });
    await cap.app.close();

    const records = assertStreamClean(cap, "interpolated request target");
    const line = records.find((r) => String(r["msg"] ?? "").startsWith("fetching"));

    expect(line, "the authored message was dropped entirely").toBeDefined();
    // The sentence survives; the target is reduced to what `route` would carry.
    expect(line?.["msg"]).toBe("fetching /__bait/interpolated for the dashboard");
    expect(cap.lines.join("\n")).not.toContain(signature);
  });

  it("leaves an authored message with no request target untouched", async () => {
    // The scrub must not paraphrase ordinary log lines; every existing call site
    // in this service is of this kind.
    const cap = capture({
      resolveCustomer: true,
      extra: (app) => {
        app.get("/__bait/plain", async (req) => {
          req.log.info({ cacheHit: true }, "reward catalogue served from cache");
          return { ok: true };
        });
      },
    });
    await enumerated(cap);
    await cap.app.inject({ method: "GET", url: "/__bait/plain" });
    await cap.app.close();

    const records = assertStreamClean(cap, "plain authored message");
    expect(records.some((r) => r["msg"] === "reward catalogue served from cache")).toBe(true);
    expect(records.some((r) => r["cacheHit"] === true)).toBe(true);
  });
});

describe("negative control — the gate fires when redaction is absent", () => {
  /**
   * WHY THIS EXISTS. Everything above asserts an absence. An absence is also what
   * a broken harness produces, a scanner whose regexes no longer match, and a
   * service that stopped logging. So the same capture and the same scanner are
   * pointed at a Fastify app whose logger has NO redacting options, and required
   * to FIND the leaks. If this ever passes silently, the gate above is worthless
   * and this is the test that says so.
   */
  it("finds the query string, the token, the email and the driver message when unfiltered", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "debug", stream: { write: (line: string) => lines.push(line.trim()) } },
    });
    app.get("/unfiltered", async (req) => {
      req.log.info({ customer: { email: BAIT.email, phone: BAIT.phone } }, "handler log");
      throw pgUniqueViolation("negativeControl");
    });

    await app.inject({
      method: "GET",
      url: `/unfiltered?${baitQuery(SHOPIFY_CUSTOMER_ID)}`,
      headers: { authorization: `Bearer ${BAIT.bearerToken}` },
    });
    await app.close();

    expect(lines.length).toBeGreaterThan(0);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const kinds = new Set(records.flatMap((r) => scanRecord(r)).map((f) => f.kind));

    // Each of these is a §24.3 row the redacting logger removes and a plain one
    // does not, so each proves one arm of the gate is live.
    expect(kinds, "the email shape was not detected").toContain("email");
    expect(kinds, "the query-material shape was not detected").toContain("query_material");
    expect(kinds, "the full-identifier shape was not detected").toContain("long_digit_run");

    expect(baitHits(lines.join("\n")).length, "no planted value was detected").toBeGreaterThan(0);
    expect(
      records.flatMap((r) => unexpectedKeys(r)),
      "no out-of-allowlist key was detected",
    ).not.toEqual([]);
  });

  it("would fail assertStreamClean on that same unfiltered stream", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "debug", stream: { write: (line: string) => lines.push(line.trim()) } },
    });
    app.get("/unfiltered", async (req) => {
      req.log.info({ email: BAIT.email }, "handler log");
      return { ok: true };
    });
    await app.inject({ method: "GET", url: `/unfiltered?${baitQuery(SHOPIFY_CUSTOMER_ID)}` });
    await app.close();

    // The whole assertion bundle, not one regex, is what must fire.
    const cap: Capture = {
      app,
      lines,
      records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
    expect(() => assertStreamClean(cap, "negative control")).toThrow();
  });
});

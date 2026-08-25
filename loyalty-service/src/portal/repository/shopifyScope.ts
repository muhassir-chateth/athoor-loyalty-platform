/**
 * THE PORTAL'S SHOPIFY-BOUNDARY CHOKE POINT (spec task 5.4, design §4.3 Rule 2/3).
 *
 * Postgres ownership is a predicate you can forget to write. Shopify ownership is
 * worse: the Admin API will happily hand you *any* order in the shop by id, and
 * the check that it belongs to the caller is a comparison in application code —
 * exactly the shape `scopedQuery.ts` exists to abolish on the database side.
 *
 * ── THE TWO QUERY FORMS, AND WHY ONLY ONE IS ALLOWED ────────────────────────
 *
 *   REJECTED, and refused by this module:
 *       query($id: ID!) { order(id: $id) { … } }        // then compare order.customer.id
 *
 *   REQUIRED:
 *       query($customerGid: ID!) {
 *         customer(id: $customerGid) { orders(query: $orderQuery) { nodes { … } } }
 *       }
 *
 * The difference is not stylistic and it is not defence in depth. Under the
 * rejected form another customer's order is *fetched* and then *rejected*, so the
 * safety of the endpoint is the presence of one `if`. Under the required form the
 * `orders` connection beneath `customer(id:)` contains only that customer's
 * orders, so a foreign order id yields an empty `nodes` array. The foreign order
 * is **unreachable rather than rejected** — there is no comparison to omit,
 * because there is nothing to compare.
 *
 * ── HOW THE FORM IS ENFORCED RATHER THAN DOCUMENTED ─────────────────────────
 *
 * 1. THE PRIMITIVE OWNS THE CUSTOMER VARIABLE. `$customerGid` is bound by
 *    {@link runScopedCustomerQuery} from the derived GID. A caller's `variables`
 *    may not contain that key at all — attempting it is refused, not merged and
 *    not silently overwritten. This is the Shopify analogue of `scopedQuery`
 *    reserving `$1`, and it is what makes pointing the traversal at another
 *    customer impossible rather than merely unlikely.
 *
 * 2. THE GID IS DERIVED, NEVER ACCEPTED. It is built only from
 *    {@link ShopifyCustomerIdLookup.findShopifyCustomerId}, called with the
 *    scope's own local customer id (design §4.3 Rule 3). No caller-supplied
 *    string reaches the GID template, and the numeric id is re-validated after
 *    the lookup returns.
 *
 * 3. THE DOCUMENT IS VALIDATED BEFORE IT IS SENT. `customer(id: $customerGid)`
 *    must be the operation's first field, and the forbidden root forms
 *    (`order(id:`, `node(id:`, `nodes(ids:`, `customers(`) must not appear
 *    anywhere. A document that would fetch by resource id is rejected without a
 *    request being made.
 *
 * ── A DISCOVERY WORTH RECORDING ─────────────────────────────────────────────
 * `shopify/purchaseHistory.ts` — shipped, and outside this task's remit — DOES
 * use the top-level `order(id:)` form, in `ORDER_LINE_ITEM_PRODUCTS_QUERY`, to
 * page line items for one order. It is not a vulnerability there: the order id
 * came from inside that customer's own `orders` connection moments earlier, so
 * provenance carries the ownership. But it is precisely the pattern a portal
 * author would copy while adding deep line-item pagination to N2 (task 8.2), and
 * at that point provenance would be an argument rather than a guarantee. This
 * module refuses the form outright so that copy cannot happen quietly; if N2
 * genuinely needs deep pagination, it will have to be a deliberate, reviewed
 * decision instead of an idiom inherited by accident.
 *
 * ── HONEST LIMITS OF LEXICAL VALIDATION ─────────────────────────────────────
 * These checks read GraphQL as text. A full parse would need a dependency, and
 * Requirement 19.2 / task 29.10 forbid adding a runtime one — `npm ls
 * --omit=dev` must be byte-identical before and after the portal. The input set
 * is small, authored here, reviewed, and additionally scanned by
 * `ownership.gate.test.ts`. What the checks reliably catch is the ordinary
 * mistake; what they cannot catch is a deliberately obfuscated document, which is
 * not the threat model for source we write ourselves.
 *
 * ── FAILURE MAPPING ─────────────────────────────────────────────────────────
 * A customer with no Shopify id, and a `customer` node Shopify will not return,
 * both mean "no such resource for this caller" and both raise
 * {@link PortalResourceNotFoundError} — the same `404`, the same body, no
 * existence oracle. A transport failure is left to propagate unchanged so the
 * caller can map it to `502 upstream_unavailable` per §6.3 N1; it is emphatically
 * NOT converted to a `404`, because "Shopify is down" must not read as "you have
 * no orders".
 *
 * SAFETY: pure to import. No network call happens until a caller passes a real
 * transport and invokes a function here. Read-only: {@link assertScopedCustomerQuery}
 * refuses any document containing a mutation.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import { PortalResourceNotFoundError, type PortalNotFoundCode } from "./scopedQuery.js";

/**
 * The GraphQL variable name a portal customer-traversal document must use.
 *
 * A FIXED NAME, not a convention. Because it is fixed, "does this document
 * traverse from the customer?" becomes a mechanical check, and because the
 * primitive binds it, a caller cannot supply it. Naming it `$customerGid` rather
 * than the `$id` that `purchaseHistory.ts` uses is deliberate: `$id` is exactly
 * the name a by-resource-id query would also choose, so the distinct name makes
 * the safe form visually and mechanically unmistakable.
 */
export const SCOPED_CUSTOMER_VARIABLE = "customerGid" as const;

/** Reasons a document is refused. Identifiers, so a test can assert the cause. */
export const REJECTED_DOCUMENT_REASONS = [
  "empty_document",
  "not_a_query",
  "contains_mutation",
  "missing_customer_variable_declaration",
  "missing_customer_traversal",
  "customer_not_first_field",
  "forbidden_root_field",
  "interpolated_document",
  "caller_supplied_customer_variable",
] as const;

export type RejectedDocumentReason = (typeof REJECTED_DOCUMENT_REASONS)[number];

/**
 * Raised when a document or its variables would leave the customer-scoped
 * traversal. Thrown before any request is made, so nothing is fetched.
 *
 * Carries the rule that failed and never the document, because this can reach a
 * 500 handler and a body echoing the query would publish the schema.
 */
export class UnscopedShopifyQueryError extends Error {
  readonly code = "unscoped_shopify_query" as const;
  readonly reason: RejectedDocumentReason;

  constructor(reason: RejectedDocumentReason) {
    super(`A portal Shopify document was rejected before execution: ${reason}.`);
    this.name = "UnscopedShopifyQueryError";
    this.reason = reason;
  }
}

/**
 * The transport surface this module needs — satisfied by
 * `ShopifyGraphqlTransport` without importing it.
 *
 * Declared structurally so a test injects a fake and NEVER reaches live Shopify,
 * and so this module does not require a shop domain and access token merely to
 * be constructed.
 */
export interface ScopedGraphqlTransport {
  request<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

/** Root fields that fetch by resource id, bypassing the customer traversal. */
const FORBIDDEN_ROOT_FIELDS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\border\s*\(\s*id\s*:/i, label: "order(id:)" },
  { pattern: /\bnode\s*\(\s*id\s*:/i, label: "node(id:)" },
  { pattern: /\bnodes\s*\(\s*ids\s*:/i, label: "nodes(ids:)" },
  { pattern: /\bcustomers\s*\(/i, label: "customers(" },
];

const CUSTOMER_VARIABLE_DECLARATION = new RegExp(
  `\\$${SCOPED_CUSTOMER_VARIABLE}\\s*:\\s*ID!`,
);

const CUSTOMER_TRAVERSAL = new RegExp(
  `\\bcustomer\\s*\\(\\s*id\\s*:\\s*\\$${SCOPED_CUSTOMER_VARIABLE}\\s*\\)`,
);

/** `gid://shopify/Customer/<digits>` — the only GID shape this module builds. */
const NUMERIC_SHOPIFY_ID = /^\d+$/;

/**
 * Proves a document traverses from the scope's customer node, or throws.
 *
 * Exported so `ownership.gate.test.ts` can run it over every document literal in
 * this directory: the gate and the runtime then share one definition of a safe
 * document, rather than drifting into two.
 */
export function assertScopedCustomerQuery(document: string): void {
  if (typeof document !== "string" || document.trim() === "") {
    throw new UnscopedShopifyQueryError("empty_document");
  }
  if (document.includes("${")) {
    // An interpolated document means part of the query was built from a value.
    // Even if that value is ours today, it is a hole the next edit can widen.
    throw new UnscopedShopifyQueryError("interpolated_document");
  }
  if (/\bmutation\b/i.test(document)) {
    // This primitive is the READ path. A write goes through the explicit
    // customer-mutation allowlist of task 14.1, which is a different, narrower
    // surface — not something a read helper should be able to reach.
    throw new UnscopedShopifyQueryError("contains_mutation");
  }
  if (!/^\s*query\b/i.test(document)) {
    // An anonymous or shorthand document has no variable declarations to check,
    // so the ownership variable could not be verified. Named queries only.
    throw new UnscopedShopifyQueryError("not_a_query");
  }
  if (!CUSTOMER_VARIABLE_DECLARATION.test(document)) {
    throw new UnscopedShopifyQueryError("missing_customer_variable_declaration");
  }

  const traversal = CUSTOMER_TRAVERSAL.exec(document);
  if (traversal === null) {
    throw new UnscopedShopifyQueryError("missing_customer_traversal");
  }

  for (const { pattern } of FORBIDDEN_ROOT_FIELDS) {
    if (pattern.test(document)) {
      throw new UnscopedShopifyQueryError("forbidden_root_field");
    }
  }

  // `customer(id: $customerGid)` must be the FIRST field in the operation's
  // selection set. Checking mere presence would accept
  // `{ shop { … } customer(id: $customerGid) { … } }` — harmless — but equally
  // `{ someRootField(id: …) { … } customer(id: $customerGid) { … } }`, where the
  // traversal is decoration beside a by-id fetch. Requiring it first means the
  // whole response is rooted in the caller's own customer node.
  const selectionStart = operationSelectionStart(document);
  if (selectionStart < 0) {
    throw new UnscopedShopifyQueryError("missing_customer_traversal");
  }
  const firstField = /[A-Za-z_][A-Za-z0-9_]*/.exec(document.slice(selectionStart + 1));
  if (firstField?.[0] !== "customer" || traversal.index < selectionStart) {
    throw new UnscopedShopifyQueryError("customer_not_first_field");
  }
}

/**
 * Index of the `{` that opens the operation's selection set.
 *
 * NOT simply `indexOf("{")`, which a variable default value would capture:
 * `query q($filter: F = { a: 1 }) { customer(…) }` would have the validator read
 * `a` as the first field and reject a perfectly safe document — and a validator
 * that produces false rejections gets loosened, which is how a real check dies.
 * So the variable-declaration parentheses are balanced first.
 */
function operationSelectionStart(document: string): number {
  const firstParen = document.indexOf("(");
  const firstBrace = document.indexOf("{");
  if (firstParen < 0 || (firstBrace >= 0 && firstBrace < firstParen)) {
    return firstBrace;
  }
  let depth = 0;
  for (let i = firstParen; i < document.length; i += 1) {
    const character = document[i];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return document.indexOf("{", i + 1);
      }
    }
  }
  return -1;
}

/**
 * The scope's Shopify customer GID, or `null` when the customer has no Shopify
 * id recorded.
 *
 * ★ THE SINGLE UNWRAP POINT for the Shopify side of the portal — the one place
 * `scope.customerId` becomes a string here, immediately handed to the lookup that
 * design §4.3 Rule 3 names as the only permitted source. `ownership.gate.test.ts`
 * asserts this file contains exactly one such unwrap.
 *
 * `null` rather than a throw, because the two callers want different things from
 * it: a detail read wants a `404`, and a list read may legitimately want an empty
 * page. The lookup's result is re-validated as numeric before it is templated, so
 * a malformed column value cannot produce a malformed GID that Shopify would
 * interpret loosely.
 */
export async function resolveScopedCustomerGid(
  lookup: ShopifyCustomerIdLookup,
  scope: CustomerScope,
): Promise<string | null> {
  // ★ the single unwrap, straight into the sanctioned lookup.
  const shopifyCustomerId = await lookup.findShopifyCustomerId(scope.customerId);
  if (shopifyCustomerId === null || !NUMERIC_SHOPIFY_ID.test(shopifyCustomerId)) {
    return null;
  }
  return `gid://shopify/Customer/${shopifyCustomerId}`;
}

/** What a scoped traversal returns: the `customer` node, shaped by the caller's document. */
interface CustomerEnvelope<T> {
  customer: T | null;
}

/**
 * Runs a customer-rooted Admin query and returns the `customer` node.
 *
 * The caller supplies the document and every variable EXCEPT
 * `$customerGid`, which this function binds from the derived GID. Passing that
 * key is an error rather than an override: silently replacing it would mean a
 * caller could believe it had chosen the customer, and the next reader of that
 * call site would believe it too.
 *
 * @throws {UnscopedShopifyQueryError} document or variables break the contract — no request is made
 * @throws {PortalResourceNotFoundError} no Shopify customer, or Shopify returned none
 */
export async function runScopedCustomerQuery<T>(
  transport: ScopedGraphqlTransport,
  lookup: ShopifyCustomerIdLookup,
  scope: CustomerScope,
  document: string,
  variables: Readonly<Record<string, unknown>> = {},
  notFoundCode: PortalNotFoundCode = "not_found",
): Promise<T> {
  assertScopedCustomerQuery(document);

  if (Object.prototype.hasOwnProperty.call(variables, SCOPED_CUSTOMER_VARIABLE)) {
    throw new UnscopedShopifyQueryError("caller_supplied_customer_variable");
  }

  const customerGid = await resolveScopedCustomerGid(lookup, scope);
  if (customerGid === null) {
    throw new PortalResourceNotFoundError(notFoundCode);
  }

  // The caller's variables first, then ours — but the guard above already
  // guarantees no collision, so this order cannot be load-bearing. Both belt and
  // braces are deliberate: the guard gives a diagnosable error, the ordering
  // means even a future refactor that drops the guard fails safe.
  const data = await transport.request<CustomerEnvelope<T>>(document, {
    ...variables,
    [SCOPED_CUSTOMER_VARIABLE]: customerGid,
  });

  const customer = data?.customer ?? null;
  if (customer === null) {
    // Shopify would not return the customer — deleted, or invisible to this
    // token. Indistinguishable from "no such resource", which is correct: the
    // caller learns nothing either way.
    throw new PortalResourceNotFoundError(notFoundCode);
  }
  return customer;
}

/* ========================================================================== *
 * Compile-time assertions (see the note in `scopedQuery.ts` — test files are
 * excluded from `tsc`, so a type assertion written there checks nothing).
 * ========================================================================== */

type Expect<T extends true> = T;

/**
 * The scope parameter cannot be widened to a `string`. The Shopify half of the
 * layer rests on the same guarantee as the Postgres half, so it is asserted the
 * same way rather than assumed to follow.
 */
export type ShopifyScopeParameterRejectsAString = Expect<
  string extends Parameters<typeof resolveScopedCustomerGid>[1] ? false : true
>;

/**
 * The GID resolver takes the lookup interface design §4.3 Rule 3 names, and
 * nothing else — so a future caller cannot pass a hand-rolled resolver that
 * accepts a Shopify id directly.
 */
export type GidComesFromTheSanctionedLookup = Expect<
  Parameters<typeof resolveScopedCustomerGid>[0] extends ShopifyCustomerIdLookup ? true : false
>;

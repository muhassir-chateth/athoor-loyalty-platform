/**
 * THE PORTAL'S DATA-ACCESS CHOKE POINT (spec task 5.4).
 *
 * Task 5.1 made a verified {@link CustomerScope} the only way to *name* a
 * customer. This module makes it the only way to *query* one. Between them they
 * are the whole IDOR story for Postgres-backed portal resources, and the split
 * matters: 5.1 stops a customer id being fabricated, this stops a legitimate
 * scope being used to read someone else's rows.
 *
 * ── THE FAILURE MODE THIS EXISTS TO REMOVE ──────────────────────────────────
 * The pattern that must not exist anywhere in the portal:
 *
 *     const row = await db.query("SELECT * FROM t WHERE id = $1", [resourceId]);
 *     if (row.customer_id !== scope.customerId) return reply.code(404).send(…);
 *
 * It reads correctly. It is also a breach waiting for one forgotten branch, and
 * worse than that: it has *already fetched* the other customer's row before it
 * decides. Every later refactor — adding a projection, extracting a helper,
 * returning early on a cache hit — is another chance to drop the comparison, and
 * nothing fails when it is dropped. Ownership belongs in the `WHERE`, where the
 * database enforces it and no code path can skip it.
 *
 * ── HOW THAT IS MADE STRUCTURAL, IN THREE INDEPENDENT LAYERS ────────────────
 *
 * 1. TYPE. Every exported function takes {@link CustomerScope}, whose brand is
 *    unexported (see `auth/customerScope.ts`). A `string` does not compile here,
 *    so `readWishlist(db, req.body.customerId)` fails `tsc` rather than review.
 *
 * 2. BINDING. **The primitive owns `$1`.** Callers supply SQL plus the
 *    parameters for `$2` onward; `scope.customerId` is prepended by
 *    {@link executeScoped} and cannot be displaced. This is the single unwrap
 *    point for the entire Postgres side of the portal — one line, greppable,
 *    reviewable — instead of one unwrap per function, each of which could bind
 *    the wrong value.
 *
 * 3. FAIL-CLOSED VALIDATION. Before anything executes,
 *    {@link validateScopedStatement} refuses SQL that does not carry customer
 *    ownership *in the statement itself*. The invariant is precise and
 *    mechanically checkable:
 *
 *        every `$1` occurrence sits in a customer-ownership position —
 *        compared to a `customer_id` column inside a WHERE clause, or supplied
 *        as the value of a leading `customer_id` column on an INSERT
 *
 *    A statement that omits the predicate throws {@link UnscopedStatementError}
 *    and issues no query. The same validator is re-run over this directory's
 *    source by `ownership.gate.test.ts`, so a future function whose SQL forgets
 *    the predicate fails an existing test *and* fails closed at runtime. One
 *    definition of "safe", enforced statically and dynamically.
 *
 * ── WHY LEXICAL VALIDATION IS ENOUGH HERE, STATED HONESTLY ──────────────────
 * These checks read SQL as text, not as a parsed grammar. A hand-crafted
 * statement could in principle satisfy them and still be wrong — a comment
 * containing `customer_id = $1`, for instance. That is acceptable *for this
 * input set and no other*: every statement is authored in this repository by us,
 * reviewed, and additionally scanned by the static gate. What the validation
 * actually buys is the case that matters — the ordinary, unmalicious omission —
 * and it converts that from an invisible breach into a loud, immediate failure.
 * No user input reaches these checks; parameters are always bound, never
 * interpolated (the `${` ban below makes that structural too).
 *
 * ── THREE OUTCOMES, KEPT DISTINGUISHABLE ON PURPOSE ─────────────────────────
 *   - zero rows                → {@link PortalResourceNotFoundError} → 404
 *   - the database failed      → {@link PortalRepositoryFaultError}  → 500
 *   - the SQL was unscoped     → {@link UnscopedStatementError}      → 500
 *
 * A fault must NEVER surface as 404 or 401. "Not yours" and "does not exist" are
 * indistinguishable from outside (that is the point); "the database is down"
 * must not join them, or an outage reads as an empty account and a real
 * escalation reads as a missing row. Zero-rows is therefore decided ONLY on a
 * resolved query result — never inside a `catch`.
 *
 * ── LOGGING: THIS MODULE EMITS NONE, DELIBERATELY ───────────────────────────
 * It holds precisely the two things §24.3 forbids logging — SQL text and bound
 * parameters, the latter including a customer id and a resource id — so the
 * safest possible contribution to the log stream is nothing at all. A test
 * asserts this file contains no logger call. Diagnostics belong at the route
 * boundary, where the 5.7 allowlist serialiser (`observability/logRedaction.ts`)
 * reduces a failure to `errorCode` and an error class. `PortalRepositoryFaultError`
 * carries the driver error on `.cause` for that boundary; the serialiser's
 * error reshaping copies only `type`, `code` and stack frames, so a `pg` error's
 * `detail`/`table`/`constraint` — which quote schema names and offending values —
 * cannot ride along. That is asserted, not assumed.
 *
 * SAFETY: pure and side-effect-free to import. It issues SQL only when a caller
 * passes a real Pool/PoolClient at runtime, and contains no DDL, no migration,
 * and no statement against `ledger_entries`, `point_lots`, `redemptions`,
 * `discount_codes` or `referrals` other than the read the caller supplies.
 */
import type { QueryResultRow } from "pg";
import type { CustomerScope } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/**
 * Base class for every failure this layer raises, so a route can catch one thing
 * and branch on the subclass rather than string-matching a code.
 */
export abstract class PortalRepositoryError extends Error {
  abstract readonly code: string;
}

/**
 * The closed set of `404` identifiers a portal repository may raise.
 *
 * CLOSED, AND WITHOUT A SINGLE DIGIT IN ANY MEMBER. A caller cannot reach for
 * `order_6543210987_not_found`, because the union has no such member and
 * {@link assertNotFoundCode} rejects anything outside it at runtime too. That is
 * the enumeration oracle closed off at the type level: the code names the *kind*
 * of resource, never the instance.
 *
 * `not_found` is §6.3's generic identifier and the default. The resource-specific
 * members exist because §4.5 names them (`order_not_found` in row 6) and a
 * client needs to distinguish "this order is gone" from "your birthday is not
 * set" to choose a designed state. What none of them may do is vary with whether
 * the foreign resource happens to exist — a real-but-foreign id and a random id
 * must produce byte-identical bodies (§4.5 row 14).
 */
export const PORTAL_NOT_FOUND_CODES = [
  "not_found",
  "order_not_found",
  "address_not_found",
  "redemption_not_found",
  "birthday_not_set",
] as const;

export type PortalNotFoundCode = (typeof PORTAL_NOT_FOUND_CODES)[number];

const NOT_FOUND_CODE_SET: ReadonlySet<string> = new Set(PORTAL_NOT_FOUND_CODES);

/**
 * Raised when a scoped statement matched zero rows.
 *
 * IT CARRIES NO RESOURCE ATTRIBUTE — no id, no table, no column, no count — and
 * the message is a fixed constant rather than a template. Requirement 2.2/2.3
 * asks that the *body* omit the resource attribute; making the *error* incapable
 * of holding one means no future handler can put it there by interpolating a
 * message it found on the error. This mirrors `ScopeUnavailableError`, which
 * withholds detail for the same reason.
 */
export class PortalResourceNotFoundError extends PortalRepositoryError {
  readonly code: PortalNotFoundCode;

  constructor(code: PortalNotFoundCode = "not_found") {
    super("The requested resource is not available to this customer.");
    this.name = "PortalResourceNotFoundError";
    this.code = assertNotFoundCode(code);
  }
}

/**
 * Raised when the database itself failed: connection refused, timeout, syntax
 * error, constraint violation.
 *
 * DISTINCT FROM NOT-FOUND AND FROM UNAUTHORISED, which is the whole reason it
 * exists as its own class. The driver error is preserved on `.cause` so the
 * route boundary can classify it, and the message is fixed so nothing from the
 * driver — which quotes offending values — reaches a response body by way of an
 * error message.
 */
export class PortalRepositoryFaultError extends PortalRepositoryError {
  readonly code = "repository_fault" as const;

  constructor(cause: unknown) {
    super("A portal repository statement failed.", { cause });
    this.name = "PortalRepositoryFaultError";
  }
}

/**
 * Raised when a statement reached the primitive without customer ownership in
 * its SQL, or otherwise violated the statement contract.
 *
 * THIS IS A PROGRAMMER ERROR SURFACED AT RUNTIME, and it fails closed: it is
 * thrown *before* the query is issued, so an unscoped statement never executes
 * even once. It is not a subclass of {@link PortalRepositoryFaultError} because
 * a test that proves "a database fault is reported as a fault" must not also
 * pass for "the SQL was unsafe" — collapsing the two would let the second hide
 * inside the first.
 *
 * `reason` is a closed identifier naming which rule failed, and `detail` repeats
 * only the rule, never the SQL: this error can propagate to a 500 handler, and a
 * 500 body that echoed the statement would hand out the schema.
 */
export class UnscopedStatementError extends PortalRepositoryError {
  readonly code = "unscoped_statement" as const;
  readonly reason: UnscopedStatementReason;

  constructor(reason: UnscopedStatementReason) {
    super(`A portal statement was rejected before execution: ${reason}.`);
    this.name = "UnscopedStatementError";
    this.reason = reason;
  }
}

/** Which validation rule a rejected statement broke. Identifiers, not sentences. */
export const UNSCOPED_STATEMENT_REASONS = [
  "empty_sql",
  "unsupported_statement_kind",
  "statement_stacking",
  "interpolated_sql",
  "missing_ownership_placeholder",
  "ownership_placeholder_misused",
  "ownership_predicate_outside_where",
  "missing_where_clause",
  "insert_customer_id_not_leading_column",
  "disjunction_in_where",
  "placeholder_numbering_mismatch",
] as const;

export type UnscopedStatementReason = (typeof UNSCOPED_STATEMENT_REASONS)[number];

/** Runtime guard so a widened union cannot smuggle an id-bearing code through. */
function assertNotFoundCode(code: string): PortalNotFoundCode {
  if (!NOT_FOUND_CODE_SET.has(code) || /\d/.test(code)) {
    // Fail closed to the generic identifier rather than propagate an unknown
    // one: a code that leaked an id would be the exact oracle we are closing.
    return "not_found";
  }
  return code as PortalNotFoundCode;
}

/* ========================================================================== *
 * The statement contract
 * ========================================================================== */

/** Statement shapes the primitive knows how to prove safe. */
export const SCOPED_STATEMENT_KINDS = ["select", "insert", "update", "delete"] as const;
export type ScopedStatementKind = (typeof SCOPED_STATEMENT_KINDS)[number];

/**
 * A statement whose `$1` is reserved for the caller's own customer id.
 *
 * `params` is `$2` onward — deliberately offset, so the shape of the type states
 * the reservation. A caller that passes its resource id first gets it bound to
 * `$2`, which is where the SQL expects it.
 */
export interface ScopedStatement {
  /** SQL carrying customer ownership. `$1` is bound by the primitive. */
  readonly sql: string;
  /** Values for `$2`, `$3`, … in order. Omit for a statement with no other parameters. */
  readonly params?: readonly unknown[];
}

/**
 * `$1` in a customer-ownership comparison: `customer_id = $1`, optionally
 * table-qualified (`r.customer_id = $1`). Anchored at the end because it is
 * tested against the text *preceding* each placeholder, which is what makes this
 * a statement about position rather than mere presence — `SELECT $1, … WHERE
 * customer_id = $2` cannot satisfy it.
 */
const OWNERSHIP_PREDICATE_TAIL = /(?:\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?\bcustomer_id\s*=\s*$/i;

/** `INSERT INTO <table> (customer_id, …` — ownership as the leading column. */
const INSERT_LEADING_CUSTOMER_ID =
  /^\s*insert\s+into\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*customer_id\s*(?:,|\))/i;

/** `VALUES ($1, …` — ownership as the first bound value, matching the column order. */
const INSERT_LEADING_PLACEHOLDER = /\bvalues\s*\(\s*\$1\s*(?:,|\))/i;

/**
 * Every `$n`. Greedy over digits so `$10` reads as ten, never as one followed by
 * a zero — a subtle way a validator can mistake `$10` for the ownership
 * placeholder and pass a statement that never binds `$1` at all.
 *
 * Built fresh per call rather than shared at module scope: a `g`-flagged regex
 * carries `lastIndex` between uses, and a shared one is a stateful global hiding
 * inside a pure-looking function.
 */
function placeholderPattern(): RegExp {
  return /\$(\d+)/g;
}

/** Classifies by leading keyword; anything else is refused rather than guessed at. */
function statementKind(sql: string): ScopedStatementKind | null {
  const leading = /^\s*([A-Za-z]+)/.exec(sql);
  const word = leading?.[1]?.toLowerCase();
  return SCOPED_STATEMENT_KINDS.find((kind) => kind === word) ?? null;
}

/** Index of the first WHERE keyword, or `-1`. */
function whereIndex(sql: string): number {
  return sql.search(/\bwhere\b/i);
}

/**
 * Proves a statement carries customer ownership, or throws
 * {@link UnscopedStatementError} without executing anything.
 *
 * @param sql the statement text
 * @param expectedParamCount number of values for `$2` onward. Omit to skip the
 *   numbering rule — the static gate scans SQL out of source with no call site
 *   in view, and a rule it cannot evaluate would have to be either skipped or
 *   faked. Skipped, explicitly, is the honest option.
 */
export function validateScopedStatement(sql: string, expectedParamCount?: number): void {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new UnscopedStatementError("empty_sql");
  }

  // A second statement after a semicolon would sit outside every check below,
  // so the whole construct is refused. Trailing semicolons included: allowing
  // them means the check has to reason about which semicolon is which.
  if (sql.includes(";")) {
    throw new UnscopedStatementError("statement_stacking");
  }

  // `${` in SQL means a value was interpolated rather than bound, which defeats
  // parameterisation entirely. Task 29.7 makes this a build gate; enforcing it
  // here too means it also fails at runtime, in the layer that would suffer.
  if (sql.includes("${")) {
    throw new UnscopedStatementError("interpolated_sql");
  }

  const kind = statementKind(sql);
  if (kind === null) {
    // Includes `WITH` (CTEs) and `INSERT … SELECT`: both can express ownership
    // correctly, and neither is provable by these rules. Refused rather than
    // waved through, so extending the layer is a deliberate act.
    throw new UnscopedStatementError("unsupported_statement_kind");
  }

  // ── Placeholder census ────────────────────────────────────────────────────
  const numbers: number[] = [];
  const ownershipPositions: number[] = [];
  const pattern = placeholderPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const raw = match[1];
    if (raw === undefined) continue;
    const n = Number.parseInt(raw, 10);
    numbers.push(n);
    if (n !== 1) continue;

    const preceding = sql.slice(0, match.index);
    if (OWNERSHIP_PREDICATE_TAIL.test(preceding)) {
      ownershipPositions.push(match.index);
      continue;
    }
    // An INSERT may instead carry ownership as its leading column/value pair.
    if (
      kind === "insert" &&
      INSERT_LEADING_CUSTOMER_ID.test(sql) &&
      INSERT_LEADING_PLACEHOLDER.test(sql)
    ) {
      ownershipPositions.push(match.index);
      continue;
    }
    // `$1` appeared somewhere that is not an ownership position. Refuse: the
    // primitive binds `$1` to the customer id, so this statement would compare
    // a customer id against the wrong column — or worse, project it.
    throw new UnscopedStatementError(
      kind === "insert" ? "insert_customer_id_not_leading_column" : "ownership_placeholder_misused",
    );
  }

  if (ownershipPositions.length === 0) {
    throw new UnscopedStatementError("missing_ownership_placeholder");
  }

  if (expectedParamCount !== undefined) {
    // The full placeholder set must be exactly 1…(params.length + 1). Catches
    // the off-by-one where a caller numbered its first parameter `$1` — which
    // would silently shift every value by one position.
    const expectedMax = expectedParamCount + 1;
    const seen = new Set(numbers);
    const contiguous =
      seen.size === expectedMax &&
      Array.from({ length: expectedMax }, (_v, i) => i + 1).every((n) => seen.has(n));
    if (!contiguous) {
      throw new UnscopedStatementError("placeholder_numbering_mismatch");
    }
  }

  if (kind === "insert") {
    // Ownership is the leading column, already proven above. An INSERT has no
    // WHERE to require, and `ON CONFLICT … DO NOTHING` adds none.
    return;
  }

  // ── SELECT / UPDATE / DELETE: ownership must FILTER ───────────────────────
  const where = whereIndex(sql);
  if (where < 0) {
    throw new UnscopedStatementError("missing_where_clause");
  }
  if (!ownershipPositions.some((position) => position > where)) {
    // The predicate exists but sits before the WHERE — in a projection, a SET
    // list or a JOIN condition. It would then not restrict the rows returned,
    // which is the one thing it is there to do.
    throw new UnscopedStatementError("ownership_predicate_outside_where");
  }

  // ── The ownership predicate must be CONJUNCTIVE ───────────────────────────
  //
  // `WHERE customer_id = $1 OR shopify_product_id = $2` passes every rule above:
  // `$1` is compared to `customer_id`, inside the WHERE, bound by the primitive.
  // And it is a total breach — the disjunction matches every row whose product
  // id matches, for every customer in the table. On a DELETE it would empty
  // other people's wishlists.
  //
  // This is the hole task 5.4's `AND <resource> = $2` phrasing is really about,
  // and it is the one an ownership check can most plausibly be defeated by while
  // still reading correctly. Refused outright rather than parsed for precedence:
  // no statement in this layer needs a disjunction, and "no OR in the WHERE" is
  // a rule that cannot be got subtly wrong. A future statement that genuinely
  // needs one has to extend this deliberately.
  //
  // Together with the numbering rule (which forces `$2` to exist and be bound)
  // and the ownership rule (which pins `$1` to the customer), this is what makes
  // `customer_id = $1 AND <resource> = $2` the only expressible targeted shape.
  const whereClause = sql.slice(where);
  if (/\bor\b/i.test(whereClause)) {
    throw new UnscopedStatementError("disjunction_in_where");
  }
}

/* ========================================================================== *
 * The primitives — the ONLY place portal SQL is executed
 * ========================================================================== */

/**
 * Validates, binds `$1` from the scope, executes, and normalises failure.
 *
 * ★ THE SINGLE UNWRAP POINT for the Postgres side of the portal. Task 5.4 asks
 * for "the single unwrap to `scope.customerId` at its boundary"; putting that
 * boundary here rather than in each repository function means an individual
 * function has no opportunity to unwrap the wrong thing — it never touches
 * `.customerId` at all. `ownership.gate.test.ts` asserts this is the only
 * occurrence in the directory, so the count stays at one.
 */
async function executeScoped<R extends QueryResultRow>(
  executor: Queryable,
  scope: CustomerScope,
  statement: ScopedStatement,
): Promise<{ rows: R[]; rowCount: number }> {
  const params = statement.params ?? [];
  validateScopedStatement(statement.sql, params.length);

  // ★ scope.customerId is prepended as $1 and cannot be displaced by a caller.
  const values: unknown[] = [scope.customerId, ...params];

  try {
    const result = await executor.query<R>(statement.sql, values);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } catch (cause) {
    // A fault, never a 404 and never a 401. Zero-rows is decided below, on a
    // resolved result only — deciding it here would turn an outage into "your
    // account is empty".
    throw new PortalRepositoryFaultError(cause);
  }
}

/** Rows owned by the scope's customer. Empty is a legitimate answer, not a 404. */
export async function scopedSelect<R extends QueryResultRow>(
  executor: Queryable,
  scope: CustomerScope,
  statement: ScopedStatement,
): Promise<R[]> {
  const { rows } = await executeScoped<R>(executor, scope, statement);
  return rows;
}

/**
 * Exactly one owned row, or `404`.
 *
 * Zero rows means "no such row *for this customer*" — the statement cannot
 * distinguish absent from foreign, and neither can the caller, which is the
 * property Requirement 2.2 asks for rather than a limitation of this function.
 */
export async function scopedSelectOne<R extends QueryResultRow>(
  executor: Queryable,
  scope: CustomerScope,
  statement: ScopedStatement,
  notFoundCode: PortalNotFoundCode = "not_found",
): Promise<R> {
  const { rows } = await executeScoped<R>(executor, scope, statement);
  const first = rows[0];
  if (first === undefined) {
    throw new PortalResourceNotFoundError(notFoundCode);
  }
  return first;
}

/**
 * A write against the scope's own rows. Returns the affected count so an
 * idempotent write — N5's `on:true` on an already-saved product, which is a
 * legitimate `200` — can distinguish "already so" from "changed" without that
 * count meaning `404`.
 */
export async function scopedMutate(
  executor: Queryable,
  scope: CustomerScope,
  statement: ScopedStatement,
): Promise<number> {
  const { rowCount } = await executeScoped(executor, scope, statement);
  return rowCount;
}

/**
 * A write that must have hit an owned row, mapping zero affected rows to `404`
 * (Requirement 2.2, 2.3).
 *
 * The `WHERE customer_id = $1 AND <resource> = $2` shape is what makes this
 * safe: a foreign resource id matches zero rows, so the response is identical
 * to a nonexistent one and the victim's row is never touched — §4.5 row 8.
 */
export async function scopedMutateExpectingRow(
  executor: Queryable,
  scope: CustomerScope,
  statement: ScopedStatement,
  notFoundCode: PortalNotFoundCode = "not_found",
): Promise<void> {
  const affected = await scopedMutate(executor, scope, statement);
  if (affected === 0) {
    throw new PortalResourceNotFoundError(notFoundCode);
  }
}

/* ========================================================================== *
 * Compile-time assertions
 * ========================================================================== *
 *
 * `tsconfig.json` EXCLUDES `src/**\/*.test.ts` and vitest transpiles without
 * type-checking, so a type-level assertion written in a test file is checked by
 * nothing. Declared here, they are enforced by the `tsc --noEmit` CI already
 * runs. They emit no JavaScript.
 */

/** Compiles only when `T` is `true`. */
type Expect<T extends true> = T;

/**
 * The brand still holds: the scope's data fields WITHOUT the brand are not a
 * `CustomerScope`. If someone exports the brand symbol, or relaxes the interface,
 * this stops compiling — which is the guarantee every function in this module
 * rests on.
 *
 * Written as `Pick<…>` rather than as a literal object type on purpose, twice
 * over. It tracks the interface automatically, so adding a field to
 * `CustomerScope` cannot leave a stale hand-copied shape asserting nothing. And
 * it avoids spelling out `customerId: string` in this directory, which
 * `ownership.gate.test.ts` forbids outright — a rule worth keeping absolute, so
 * the file that defines the choke point does not become its own exception.
 */
export type ScopeRemainsUnforgeable = Expect<
  Pick<CustomerScope, "customerId" | "channel" | "source"> extends CustomerScope ? false : true
>;

/**
 * The scope parameter cannot be widened to accept a `string`.
 *
 * THIS IS THE ASSERTION THAT MATTERS MOST IN THIS FILE. The whole layer's safety
 * rests on "you cannot call it with a bare customer id", and the cheapest way to
 * lose that is a well-meant convenience overload — `scopedSelect(db, customerId
 * | scope, …)` — added by someone wiring a script. That change compiles fine on
 * its own; it stops compiling here.
 */
export type ScopeParameterRejectsAString = Expect<
  string extends Parameters<typeof scopedSelect>[1] ? false : true
>;

/**
 * A statement cannot carry a customer identifier of its own.
 *
 * `$1` comes from the scope, so a `customerId` field on {@link ScopedStatement}
 * would be a second, unverified source for the same value — precisely the
 * ambiguity `CustomerScope` exists to remove.
 */
export type StatementCannotNameACustomer = Expect<
  "customerId" extends keyof ScopedStatement ? false : true
>;

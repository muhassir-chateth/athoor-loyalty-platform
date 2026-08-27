/**
 * The customer data export (spec task 15.1, design §15.4, Req 23.3, 23.4, 2.4,
 * 2.6).
 *
 * ── ISOLATION IS STRUCTURAL: THERE IS ONE CUSTOMER IN SCOPE, EVER ───────────
 * Requirement 23.4 forbids another customer's record appearing in an export, and
 * §15.4 says how that is achieved: "the export is built from ⟨scope⟩ alone, so
 * there is no code path that could include one". This module takes a
 * {@link CustomerScope} and a set of readers that each take the same scope. There
 * is no customer id parameter, no list of ids, no join across customers, and no
 * branch that could widen. The property is not checked at the end — it holds
 * because nothing in the assembly can express the alternative.
 *
 * ── WHAT IS EXCLUDED, AND WHY EACH EXCLUSION MATTERS ────────────────────────
 * §15.4 names three exclusions and they are different in kind:
 *
 *   1. Another customer's records — Requirement 23.4, structural as above.
 *   2. INTERNAL SYSTEM ROWS: webhook events, idempotency keys, job records. These
 *      are not the customer's data, they are the machinery's. Including an
 *      idempotency key would also hand back a value that acts as a replay token,
 *      and including webhook rows would publish operational internals.
 *   3. The DERIVED fragrance block (§15.9). This one is the subtle one and it is
 *      not an oversight: an inference is OUR reading of behaviour and may simply
 *      be wrong, so exporting it as though it were the customer's data would
 *      misrepresent a guess as a record. The INPUTS are exported instead —
 *      purchases, wishlist, favourites, views, declared preferences — which is
 *      strictly more useful, because the customer can see what the conclusion was
 *      drawn from rather than only the conclusion.
 *
 * ── DETERMINISTIC, SO TWO EXPORTS OF UNCHANGED DATA MATCH ───────────────────
 * Every collection is ordered by its reader, keys are emitted in a fixed order,
 * and the only non-deterministic value is `generatedAt`, which is supplied by an
 * injected clock so tests pin it. That makes "the same data exports the same
 * bytes" a testable property rather than a hope.
 *
 * SAFETY: pure assembly over injected readers. No SQL, no network, no clock of its
 * own. Never reads a token, a secret, or another customer's row.
 */
import type { CustomerScope } from "../auth/customerScope.js";

/** The version of the export document's own shape. */
export const EXPORT_FORMAT_VERSION = 1 as const;

/**
 * Everything the export needs, as one injected reader set.
 *
 * EACH READER IS SCOPE-TYPED. None takes a customer id, so the assembly cannot
 * name a customer even by accident — and a future reader added here has to satisfy
 * the same signature to compile.
 *
 * Every reader is allowed to FAIL. A section that cannot be read is reported as
 * `null` with its name listed in `unavailable`, rather than omitted silently or
 * failing the whole export: a customer exercising a data-access right should
 * receive what is available plus an honest statement of what was not, not a 502
 * because one upstream was briefly down.
 */
export interface ExportReaders {
  readonly identity: (scope: CustomerScope) => Promise<unknown>;
  readonly addresses: (scope: CustomerScope) => Promise<unknown>;
  readonly consent: (scope: CustomerScope) => Promise<unknown>;
  readonly balance: (scope: CustomerScope) => Promise<unknown>;
  readonly ledger: (scope: CustomerScope) => Promise<unknown>;
  readonly redemptions: (scope: CustomerScope) => Promise<unknown>;
  readonly referral: (scope: CustomerScope) => Promise<unknown>;
  readonly wishlist: (scope: CustomerScope) => Promise<unknown>;
  readonly favourites: (scope: CustomerScope) => Promise<unknown>;
  readonly recentlyViewed: (scope: CustomerScope) => Promise<unknown>;
  readonly preferences: (scope: CustomerScope) => Promise<unknown>;
  readonly birthday: (scope: CustomerScope) => Promise<unknown>;
  readonly portalVisits: (scope: CustomerScope) => Promise<unknown>;
  readonly erasureRequests: (scope: CustomerScope) => Promise<unknown>;
}

/** The section names, in the order the document emits them. */
export const EXPORT_SECTIONS = [
  "identity",
  "addresses",
  "consent",
  "balance",
  "ledger",
  "redemptions",
  "referral",
  "wishlist",
  "favourites",
  "recentlyViewed",
  "preferences",
  "birthday",
  "portalVisits",
  "erasureRequests",
] as const satisfies readonly (keyof ExportReaders)[];

export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** An injectable clock, so `generatedAt` is pinnable in a test. */
export interface ExportClock {
  now(): Date;
}

/** The assembled export document. */
export interface CustomerDataExport {
  readonly formatVersion: typeof EXPORT_FORMAT_VERSION;
  readonly generatedAt: string;
  /**
   * Sections that could not be read, by name.
   *
   * An identifier list, never a sentence, and it carries no reason — an upstream
   * failure's cause is operational detail, not the customer's data, and §5.5
   * forbids upstream text in a body regardless.
   */
  readonly unavailable: readonly ExportSection[];
  /**
   * A NOTE ON WHAT IS ABSENT, in the document itself.
   *
   * A customer reading their export should not have to wonder whether the derived
   * fragrance block was forgotten. Saying it is excluded, and why, is part of
   * being honest about what is held — and it is an identifier plus a fixed
   * explanation, so it is not upstream text.
   */
  readonly excluded: readonly { readonly section: string; readonly reason: string }[];
  readonly data: Readonly<Record<ExportSection, unknown>>;
}

/**
 * Sections deliberately absent, stated in the document (§15.4, §15.9).
 *
 * `reason` is OUR fixed wording, not upstream text, and is deliberately short. It
 * exists so the omission reads as a decision rather than a gap.
 */
const EXCLUDED_SECTIONS: readonly { section: string; reason: string }[] = Object.freeze([
  Object.freeze({
    section: "inferredFragranceProfile",
    reason: "derived_not_stored",
  }),
  Object.freeze({
    section: "internalSystemRecords",
    reason: "not_customer_data",
  }),
]);

/**
 * Assembles the export for one customer.
 *
 * Sections are read CONCURRENTLY but assembled in the fixed
 * {@link EXPORT_SECTIONS} order, so the document's key order is a property of this
 * module rather than of how fast each reader happened to resolve.
 */
export async function buildCustomerDataExport(
  readers: ExportReaders,
  scope: CustomerScope,
  clock: ExportClock,
): Promise<CustomerDataExport> {
  const settled = await Promise.all(
    EXPORT_SECTIONS.map(async (section) => {
      try {
        return { section, value: await readers[section](scope), ok: true as const };
      } catch {
        // The error is DISCARDED, not logged and not carried. It could hold an
        // upstream message, and §15.7's logging policy plus §5.5's body rule both
        // forbid that reaching a customer or a log line. The section name alone is
        // what the customer needs.
        return { section, value: null, ok: false as const };
      }
    }),
  );

  const data = {} as Record<ExportSection, unknown>;
  const unavailable: ExportSection[] = [];
  // Iterate the FIXED order, not `settled`, so key order cannot depend on timing.
  for (const section of EXPORT_SECTIONS) {
    const entry = settled.find((s) => s.section === section);
    data[section] = entry?.ok === true ? entry.value : null;
    if (entry?.ok !== true) unavailable.push(section);
  }

  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: clock.now().toISOString(),
    unavailable,
    excluded: EXCLUDED_SECTIONS,
    data,
  };
}

/**
 * The `Content-Disposition` filename.
 *
 * CARRIES NO CUSTOMER IDENTIFIER. The obvious filename would embed the customer id
 * or email, and both would put an identifier into a value that ends up in a
 * downloads folder, a browser history entry and quite possibly a support ticket
 * screenshot. The date is enough to tell two exports apart.
 */
export function exportFilename(generatedAt: string): string {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(generatedAt)?.[1] ?? "export";
  return `athoor-data-export-${day}.json`;
}

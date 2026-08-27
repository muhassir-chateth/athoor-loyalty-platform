/**
 * Wiring the export's readers to the shipped sources (spec task 15.1,
 * design §15.4).
 *
 * ── WHY THIS IS A MODULE AND NOT A BLOCK IN index.ts ────────────────────────
 * Fourteen readers is enough composition to be worth testing, and `index.ts` is
 * boot glue that no test exercises. Putting the mapping here means the assertion
 * "the export composes the SHIPPED readers rather than new SQL" is checkable, and
 * `index.ts` keeps a single line.
 *
 * ── IT COMPOSES, IT DOES NOT QUERY ──────────────────────────────────────────
 * Not one SQL statement appears in this file. Every section is served by the reader
 * that already owns that table — the balance source, the history source, the
 * redemption source, the scope-typed repository functions from tasks 9 to 14. A
 * second reader of any of those tables would be a second answer to "what does this
 * customer have", which is the defect §8.2 removed for the wishlist and §12.1
 * refused for inferred preferences.
 *
 * The only exceptions are the two tables that HAD no scope-typed reader —
 * `portal_visits` and `customer_recently_viewed` — and those were added to
 * `portal/repository/erasure.ts` so their ownership predicates are proven by the
 * ownership gate rather than written here.
 *
 * ── THE UNWRAP IS HERE, WHICH IS WHERE IT BELONGS ───────────────────────────
 * Some shipped sources are keyed on a `customerId` string rather than a
 * `CustomerScope` — `CustomerBalanceSource.load`, `LedgerHistorySource.load`. The
 * adapters below unwrap the scope for exactly those calls. That is the established
 * pattern outside the repository layer (`routes/profile.ts` does the same), and the
 * ownership gate's zero-unwrap rule applies to `portal/repository/**`, which this
 * file is deliberately not part of.
 *
 * SAFETY: no SQL, no network of its own, no clock. Every reader is scope-typed, so
 * no section can be assembled for a customer other than the one in scope.
 */
import type { CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import type { ExportReaders } from "./export.js";
import {
  readErasureRequests,
  readPortalVisits,
  readRecentlyViewedForExport,
} from "../portal/repository/erasure.js";
import { readBirthday } from "../portal/repository/birthday.js";
import { readFavourites, readWishlist } from "../portal/repository/customerOwned.js";
import {
  readCommunicationPreferences,
  readDeclaredPreferences,
} from "../portal/repository/preferences.js";
import { projectCommunication, projectDeclared } from "../profile/preferences.js";

/** A section reader that is not wired reports `null` rather than failing the export. */
const ABSENT = async (): Promise<null> => null;

/** The shipped sources this composition draws on. Each is optional. */
export interface ExportSourceSet {
  /** The pool or client behind every database-backed section. */
  readonly db?: Queryable;
  /** Shopify-backed identity, addresses and consent (task 14). */
  readonly shopify?: {
    readonly identity: (scope: CustomerScope) => Promise<unknown>;
    readonly addresses: (scope: CustomerScope) => Promise<unknown>;
    readonly consent: (scope: CustomerScope) => Promise<unknown>;
  };
  /** `GET /v1/balance`'s source (task 10.1). Keyed on a customer id string. */
  readonly balance?: { load(customerId: string): Promise<unknown> };
  /** `GET /v1/history`'s source. Keyed on a query object. */
  readonly ledger?: { load(query: { customerId: string; page: number; pageSize: number }): Promise<unknown> };
  /** `GET /v1/redemptions`'s source (task 10.2). Already scope-typed. */
  readonly redemptions?: { list(scope: CustomerScope, pageSize: number): Promise<unknown> };
  /** `GET /v1/referral`'s reader (task 11.1). Already scope-typed. */
  readonly referral?: (scope: CustomerScope) => Promise<unknown>;
}

/**
 * How many ledger entries and redemptions the export includes.
 *
 * §15.4 asks for "the full ledger". These are the largest page the paginated
 * sources accept in one call, chosen so the export is complete for every realistic
 * account rather than silently truncated at a page boundary. A customer whose
 * history exceeded this would receive the most recent 10,000 entries; the number is
 * stated here rather than left implicit so that limit is a known quantity.
 */
export const EXPORT_LEDGER_PAGE_SIZE = 10_000 as const;
export const EXPORT_REDEMPTION_PAGE_SIZE = 1_000 as const;

/** Builds the fourteen readers from whatever sources are available. */
export function buildExportReaders(sources: ExportSourceSet): ExportReaders {
  const db = sources.db;

  return {
    identity: sources.shopify?.identity ?? ABSENT,
    addresses: sources.shopify?.addresses ?? ABSENT,
    consent: sources.shopify?.consent ?? ABSENT,

    balance:
      sources.balance === undefined
        ? ABSENT
        : // The unwrap, at the one boundary that needs it — see the module header.
          async (scope) => sources.balance?.load(scope.customerId) ?? null,

    ledger:
      sources.ledger === undefined
        ? ABSENT
        : async (scope) =>
            sources.ledger?.load({
              customerId: scope.customerId,
              page: 1,
              pageSize: EXPORT_LEDGER_PAGE_SIZE,
            }) ?? null,

    redemptions:
      sources.redemptions === undefined
        ? ABSENT
        : async (scope) => sources.redemptions?.list(scope, EXPORT_REDEMPTION_PAGE_SIZE) ?? null,

    referral: sources.referral ?? ABSENT,

    wishlist: db === undefined ? ABSENT : async (scope) => readWishlist(db, scope),
    favourites: db === undefined ? ABSENT : async (scope) => readFavourites(db, scope),
    recentlyViewed:
      db === undefined ? ABSENT : async (scope) => readRecentlyViewedForExport(db, scope),

    preferences:
      db === undefined
        ? ABSENT
        : async (scope) => {
            // Both halves, projected exactly as N12 returns them, so an export and
            // the settings screen agree about what is declared.
            const [declaredRows, communicationRow] = await Promise.all([
              readDeclaredPreferences(db, scope),
              readCommunicationPreferences(db, scope),
            ]);
            return {
              declared: projectDeclared(declaredRows),
              communication: projectCommunication(communicationRow),
            };
          },

    // Month and day only. There is no birth year to export because none is ever
    // collected (Req 11.10) — the export cannot leak what the schema cannot hold.
    birthday: db === undefined ? ABSENT : async (scope) => readBirthday(db, scope),

    portalVisits: db === undefined ? ABSENT : async (scope) => readPortalVisits(db, scope),
    erasureRequests: db === undefined ? ABSENT : async (scope) => readErasureRequests(db, scope),
  };
}

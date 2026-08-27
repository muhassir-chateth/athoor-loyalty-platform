/**
 * Declared-preference domain rules (spec task 13.1, design §12.2/§12.8,
 * Req 12.1, 12.2, 12.7, 13.1, 13.2, 21.7).
 *
 * ── THIS MODULE IS THE ONLY RULE SET ────────────────────────────────────────
 * Vocabularies, caps, defaults and validation live here and NOWHERE else. The
 * route calls `validatePreferencesUpdate` and does not re-derive a single code —
 * task 12 shipped a route that translated `zod`'s issue taxonomy into field codes
 * in parallel with a domain validator that already produced them, and the two had
 * silently drifted: a missing key and a wrongly-typed one both came back as
 * `not_an_integer`. One rule set, one place, is the lesson applied in advance.
 *
 * ── WHY THE VOCABULARIES ARE DATA AND NOT TYPES ─────────────────────────────
 * §12.2 makes the vocabularies SERVER-OWNED so they can grow without a theme
 * deploy: the client renders the options the API supplies. Encoding them as
 * literal unions would put the vocabulary back in the theme bundle and defeat the
 * reason it lives here. They are therefore `readonly string[]`, validated at the
 * boundary rather than by the compiler.
 *
 * ── MARKETING CONSENT IS NOT HERE ───────────────────────────────────────────
 * Shopify owns marketing consent (§13.1, Req 3.2, 13.4) and it is read and
 * written through N9. There is deliberately no field, no default and no code path
 * for it in this module: a second copy would be two sources of truth for the one
 * value where disagreement is a compliance failure rather than a bug.
 *
 * `push_enabled` is likewise absent from every contract here. It is a reserved
 * column (§14.2) that appears in no contract in §12.8, and inventing a wire name
 * for it now would be inventing a name the design does not specify.
 *
 * SAFETY: pure functions and constants. No I/O, no SQL, no clock, no randomness.
 */
import type {
  PortalCommunicationPreferences,
  PortalDeclaredPreferences,
  PortalPreferenceDimension,
  PortalPreferenceLimits,
  PortalPreferenceVocabulary,
} from "../portal/types.js";

/* ========================================================================== *
 * The five dimensions
 * ========================================================================== */

/**
 * Every dimension, in the order `GET` presents them.
 *
 * Ordered explicitly rather than taken from `Object.keys` of the vocabulary,
 * because §12.3's determinism rule bans iterating a hash-ordered collection
 * without an explicit sort — and a response whose key order depends on insertion
 * order is the same class of defect one level up.
 */
export const PREFERENCE_DIMENSIONS = [
  "scent_family",
  "note",
  "intensity",
  "occasion",
  "season",
] as const satisfies readonly PortalPreferenceDimension[];

/**
 * The four dimensions that hold a SET. `intensity` is excluded because it holds
 * one value or none (§12.2), enforced in the database by a partial unique index
 * on `(customer_id) WHERE dimension = 'intensity'`.
 *
 * "I like bold fragrances and subtle fragrances" is not a preference, it is the
 * absence of one — which is why this is a cardinality distinction rather than a
 * cap of one.
 */
export const MULTI_VALUED_DIMENSIONS = [
  "scent_family",
  "note",
  "occasion",
  "season",
] as const satisfies readonly PortalPreferenceDimension[];

/** The single-valued dimension, named once so no caller re-tests the string. */
export const SINGLE_VALUED_DIMENSION = "intensity" as const;

/* ========================================================================== *
 * Server-owned vocabularies (§12.2)
 * ========================================================================== */

/**
 * The values the server accepts, per dimension.
 *
 * `scent_family`, `intensity`, `occasion` and `season` are quoted verbatim from
 * §12.2's cardinality table and §12.8's contract example, in that order.
 *
 * `note` IS A JUDGEMENT CALL AND IS FLAGGED AS ONE. §12.2 specifies "a bounded
 * list of notes the catalogue actually uses (rose, saffron, sandalwood, vanilla,
 * bergamot, …)" — five examples and an ellipsis, so the remainder is not
 * specified anywhere in the approved design. The list below extends those five
 * with notes common to an oud-and-amber house, kept deliberately short: an
 * over-long vocabulary is a worse starting point than a short one, because a
 * value the catalogue does not use is a control the customer can select and then
 * never see reflected anywhere.
 *
 * Growing it is a one-line, additive server change with NO theme deploy and NO
 * migration — exactly the property §12.2 chose server-owned vocabularies for.
 * Values are never removed once shipped: a stored preference whose value left the
 * vocabulary would read back as invalid.
 *
 * IT MUST HOLD AT LEAST `PREFERENCE_LIMITS.note` VALUES, and `preferences.test.ts`
 * asserts that for every capped dimension. A cap of 20 over a vocabulary of 15
 * would be a cap no customer could ever reach, which makes the `limits` block the
 * client renders against a statement about nothing.
 */
export const PREFERENCE_VOCABULARY: PortalPreferenceVocabulary = Object.freeze({
  scent_family: Object.freeze([
    "oud",
    "amber",
    "floral",
    "woody",
    "musk",
    "spice",
    "citrus",
    "leather",
    "gourmand",
    "aquatic",
    "green",
  ]),
  note: Object.freeze([
    "rose",
    "saffron",
    "sandalwood",
    "vanilla",
    "bergamot",
    "jasmine",
    "patchouli",
    "cedar",
    "vetiver",
    "tonka",
    "incense",
    "cardamom",
    "iris",
    "tuberose",
    "amberwood",
    "musk",
    "leather",
    "oakmoss",
    "cinnamon",
    "labdanum",
    "orange_blossom",
    "ambergris",
  ]),
  intensity: Object.freeze(["subtle", "balanced", "bold"]),
  occasion: Object.freeze(["daily", "evening", "formal", "celebration", "gifting", "travel"]),
  season: Object.freeze(["spring", "summer", "autumn", "winter"]),
});

/**
 * Per-dimension caps (§12.2, §12.8's `limits` block).
 *
 * `intensity` HAS NO ENTRY — it is single-valued, not capped, and §12.8 lists
 * exactly these four keys. The values live here, with the validator that enforces
 * them; the write transaction enforces the same numbers by calling this validator
 * rather than by holding its own copy.
 */
export const PREFERENCE_LIMITS: PortalPreferenceLimits = Object.freeze({
  scent_family: 10,
  note: 20,
  occasion: 6,
  season: 4,
});

/**
 * The defaults a customer has before their row exists.
 *
 * THESE MIRROR THE DATABASE `DEFAULT`s in `1786200000000_create-communication-
 * preferences`, and `preferences.test.ts` asserts they still agree by reading the
 * migration. Two places state them because they answer different questions — the
 * column default decides what a first write stores, this constant decides what a
 * read reports for a customer who has never written — and a drift between them
 * would make the value a customer sees change the moment they saved something
 * unrelated.
 *
 * The asymmetry is deliberate (§14.2): the two promotional channels are opt-IN,
 * while the two the customer has already asked for by acting — setting a birthday,
 * making a referral — are opt-OUT.
 */
export const COMMUNICATION_DEFAULTS: PortalCommunicationPreferences = Object.freeze({
  productLaunches: false,
  restockAlerts: false,
  birthdayMessages: true,
  referralUpdates: true,
});

/** The four communication keys, paired with their database column names. */
export const COMMUNICATION_COLUMNS = Object.freeze([
  { key: "productLaunches", column: "product_launches" },
  { key: "restockAlerts", column: "restock_alerts" },
  { key: "birthdayMessages", column: "birthday_messages" },
  { key: "referralUpdates", column: "referral_updates" },
] as const);

/** A communication preference key. */
export type CommunicationKey = (typeof COMMUNICATION_COLUMNS)[number]["key"];

/* ========================================================================== *
 * Validation (Req 21.7 — codes, never sentences)
 * ========================================================================== */

/** One rejected field, as a CODE. The client owns the wording (design E.1 rule 4). */
export interface PreferenceFieldError {
  /** Dotted path of the offending field, e.g. `declared.scent_family`. */
  readonly field: string;
  readonly code:
    | "unknown_dimension"
    | "unknown_key"
    | "not_an_array"
    | "not_a_string"
    | "not_a_boolean"
    | "not_an_object"
    | "unknown_value"
    | "duplicate_value"
    | "too_many_values";
}

/** A validated, normalised update. Absent keys were not supplied and stay untouched. */
export interface ValidatedPreferencesUpdate {
  /**
   * Per-dimension SET REPLACEMENTS. A present dimension replaces that dimension
   * entirely; an absent one is left alone. `intensity` carries zero or one value,
   * so clearing it is the empty array rather than a separate operation.
   */
  readonly declared: ReadonlyMap<PortalPreferenceDimension, readonly string[]>;
  /** Only the communication keys the caller supplied. */
  readonly communication: ReadonlyMap<CommunicationKey, boolean>;
}

/** The outcome of validating a body: either an update to apply, or field codes. */
export type PreferencesValidation =
  | { readonly ok: true; readonly update: ValidatedPreferencesUpdate }
  | { readonly ok: false; readonly errors: readonly PreferenceFieldError[] };

/** Reads an untrusted value as a bag of unknowns without asserting it is one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True iff `dimension` is one of the five. Narrows for the caller. */
export function isPreferenceDimension(dimension: string): dimension is PortalPreferenceDimension {
  return (PREFERENCE_DIMENSIONS as readonly string[]).includes(dimension);
}

/**
 * Validates a `PUT /v1/profile/preferences` body (§12.8).
 *
 * ── EVERY DIMENSION IS CHECKED, NOT JUST THE FIRST TO FAIL ──────────────────
 * A customer editing two dimensions at once should be told about both, not made
 * to submit twice to discover the second problem.
 *
 * ── AN UNKNOWN KEY IS AN ERROR, NOT SOMETHING TO STRIP ──────────────────────
 * `zod`'s `.strip()` is the right answer where a stray field is a client mistake
 * with an obvious intent — `year` on a birthday (Req 11.10). Here it is the wrong
 * answer: silently dropping `declared.scentFamily` (a plausible camelCase slip)
 * would return `200` with the change not applied, and the client would render the
 * old value as though the save had worked. Naming the key is the honest outcome.
 *
 * ── THE EMPTY BODY IS VALID ─────────────────────────────────────────────────
 * `{}` applies nothing and returns the stored state, which is exactly what a
 * no-op save should do. It is not an error, because "the customer pressed save
 * without changing anything" is not a failure.
 */
export function validatePreferencesUpdate(body: unknown): PreferencesValidation {
  const errors: PreferenceFieldError[] = [];
  const declared = new Map<PortalPreferenceDimension, readonly string[]>();
  const communication = new Map<CommunicationKey, boolean>();

  const root = asRecord(body);
  if (root === null) {
    return { ok: false, errors: [{ field: "body", code: "not_an_object" }] };
  }

  for (const key of Object.keys(root)) {
    if (key !== "declared" && key !== "communication") {
      errors.push({ field: key, code: "unknown_key" });
    }
  }

  /* ----------------------------- declared ------------------------------ */
  if (root.declared !== undefined) {
    const block = asRecord(root.declared);
    if (block === null) {
      errors.push({ field: "declared", code: "not_an_object" });
    } else {
      // Iterate the SUPPLIED keys so an unknown dimension is reported rather than
      // ignored, then validate in the canonical dimension order so two identical
      // bodies produce an identical error list.
      for (const key of Object.keys(block)) {
        if (!isPreferenceDimension(key)) {
          errors.push({ field: `declared.${key}`, code: "unknown_dimension" });
        }
      }
      for (const dimension of PREFERENCE_DIMENSIONS) {
        if (!(dimension in block)) continue;
        const raw = block[dimension];
        const field = `declared.${dimension}`;
        const allowed = PREFERENCE_VOCABULARY[dimension];

        if (dimension === SINGLE_VALUED_DIMENSION) {
          // `null` CLEARS it. A single value replaces it. An array is refused:
          // accepting `["bold"]` here would make the wire shape ambiguous about a
          // dimension whose whole point is that it holds one value.
          if (raw === null) {
            declared.set(dimension, []);
          } else if (typeof raw !== "string") {
            errors.push({ field, code: "not_a_string" });
          } else if (!allowed.includes(raw)) {
            errors.push({ field, code: "unknown_value" });
          } else {
            declared.set(dimension, [raw]);
          }
          continue;
        }

        if (!Array.isArray(raw)) {
          errors.push({ field, code: "not_an_array" });
          continue;
        }
        // Cap FIRST, so a 500-element array is refused without 500 membership
        // tests and without 500 field errors in the response.
        const cap = PREFERENCE_LIMITS[dimension as keyof PortalPreferenceLimits];
        if (raw.length > cap) {
          errors.push({ field, code: "too_many_values" });
          continue;
        }
        let sound = true;
        const seen = new Set<string>();
        for (const value of raw) {
          if (typeof value !== "string") {
            errors.push({ field, code: "not_a_string" });
            sound = false;
            break;
          }
          if (!allowed.includes(value)) {
            errors.push({ field, code: "unknown_value" });
            sound = false;
            break;
          }
          if (seen.has(value)) {
            // The store would dedupe this silently (the primary key is a set), so
            // accepting it would mean a body naming 11 families stored 10 and
            // reported success. Naming it lets the client fix its own state.
            errors.push({ field, code: "duplicate_value" });
            sound = false;
            break;
          }
          seen.add(value);
        }
        if (sound) {
          // Stored in VOCABULARY ORDER, not submitted order. The table is a set
          // with no ordering column, so the read cannot preserve submission order
          // anyway — normalising here means a write and the read that follows it
          // agree, and two clients submitting the same set in different orders
          // produce byte-identical stored state.
          declared.set(
            dimension,
            allowed.filter((value) => seen.has(value)),
          );
        }
      }
    }
  }

  /* --------------------------- communication --------------------------- */
  if (root.communication !== undefined) {
    const block = asRecord(root.communication);
    if (block === null) {
      errors.push({ field: "communication", code: "not_an_object" });
    } else {
      const known = new Set<string>(COMMUNICATION_COLUMNS.map((c) => c.key));
      for (const key of Object.keys(block)) {
        if (!known.has(key)) {
          // Catches `marketingConsent` explicitly rather than by omission. A
          // client that tries to set consent here is told the key does not exist,
          // instead of receiving a `200` that implies consent was recorded
          // somewhere it is not (§13.1 — Shopify owns it, through N9).
          errors.push({ field: `communication.${key}`, code: "unknown_key" });
        }
      }
      for (const { key } of COMMUNICATION_COLUMNS) {
        if (!(key in block)) continue;
        const raw = block[key];
        if (typeof raw !== "boolean") {
          errors.push({ field: `communication.${key}`, code: "not_a_boolean" });
          continue;
        }
        communication.set(key, raw);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, update: { declared, communication } };
}

/* ========================================================================== *
 * Projection
 * ========================================================================== */

/** One stored `(dimension, value)` pair, as the read projects it. */
export interface StoredPreferenceRow {
  readonly dimension: string;
  readonly value: string;
}

/**
 * Folds stored rows into the wire shape (§12.8).
 *
 * ── A STORED VALUE OUTSIDE THE VOCABULARY IS DROPPED, NOT SURFACED ──────────
 * It should be unreachable: the write validates against the same vocabulary and
 * the column has a `CHECK`. But if it ever happens — a hand-run `UPDATE`, or a
 * value removed from the vocabulary in error — returning it would hand the client
 * an option it cannot render and cannot unset. Dropping it degrades to "not
 * declared", which the customer can correct. The vocabulary order also makes the
 * output independent of row order, which matters because a `SELECT` without an
 * `ORDER BY` on every projected column has no guaranteed order.
 */
export function projectDeclared(rows: readonly StoredPreferenceRow[]): PortalDeclaredPreferences {
  const byDimension = new Map<PortalPreferenceDimension, Set<string>>();
  for (const dimension of PREFERENCE_DIMENSIONS) byDimension.set(dimension, new Set());
  for (const row of rows) {
    if (!isPreferenceDimension(row.dimension)) continue;
    if (!PREFERENCE_VOCABULARY[row.dimension].includes(row.value)) continue;
    byDimension.get(row.dimension)?.add(row.value);
  }
  const pick = (dimension: PortalPreferenceDimension): readonly string[] => {
    const held = byDimension.get(dimension) ?? new Set<string>();
    return PREFERENCE_VOCABULARY[dimension].filter((value) => held.has(value));
  };
  const intensity = pick(SINGLE_VALUED_DIMENSION);
  return {
    scent_family: pick("scent_family"),
    note: pick("note"),
    // At most one row can exist (partial unique index); `[0] ?? null` is the
    // projection of that, not a choice among several.
    intensity: intensity[0] ?? null,
    occasion: pick("occasion"),
    season: pick("season"),
  };
}

/** The stored communication row, or `null` when the customer has never written one. */
export interface StoredCommunicationRow {
  readonly product_launches: boolean;
  readonly restock_alerts: boolean;
  readonly birthday_messages: boolean;
  readonly referral_updates: boolean;
}

/**
 * Projects the communication row, applying {@link COMMUNICATION_DEFAULTS} when
 * there is none.
 *
 * A missing row means "defaults apply" (§14.2) — a customer who has never opened
 * Settings is never written to, so absence is the normal state rather than an
 * error or an empty object.
 */
export function projectCommunication(
  row: StoredCommunicationRow | null,
): PortalCommunicationPreferences {
  if (row === null) return { ...COMMUNICATION_DEFAULTS };
  return {
    productLaunches: row.product_launches,
    restockAlerts: row.restock_alerts,
    birthdayMessages: row.birthday_messages,
    referralUpdates: row.referral_updates,
  };
}

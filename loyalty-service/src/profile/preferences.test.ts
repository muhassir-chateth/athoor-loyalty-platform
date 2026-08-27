/**
 * Declared-preference domain tests — task 13.1/13.2, §12.2/§12.8,
 * Req 12.1, 12.2, 12.7, 13.1, 13.2, 21.7.
 *
 * SAFETY: pure functions only. No network, no database, no production.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMUNICATION_COLUMNS,
  COMMUNICATION_DEFAULTS,
  MULTI_VALUED_DIMENSIONS,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LIMITS,
  PREFERENCE_VOCABULARY,
  SINGLE_VALUED_DIMENSION,
  isPreferenceDimension,
  projectCommunication,
  projectDeclared,
  validatePreferencesUpdate,
  type PreferenceFieldError,
} from "./preferences.js";
import { COMMUNICATION_PARAM_KEYS } from "../portal/repository/preferences.js";

/** Validates and returns the field codes, or fails the test if it unexpectedly passed. */
function errorsOf(body: unknown): readonly PreferenceFieldError[] {
  const result = validatePreferencesUpdate(body);
  if (result.ok) throw new Error(`expected rejection, got ok: ${JSON.stringify(body)}`);
  return result.errors;
}

/** Validates and returns the update, or fails the test if it was rejected. */
function updateOf(body: unknown) {
  const result = validatePreferencesUpdate(body);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.update;
}

describe("the five dimensions and their cardinality (§12.2)", () => {
  it("holds exactly the five dimensions the CHECK constraint allows", () => {
    expect([...PREFERENCE_DIMENSIONS]).toEqual([
      "scent_family",
      "note",
      "intensity",
      "occasion",
      "season",
    ]);
  });

  it("treats intensity as single-valued and the other four as sets", () => {
    expect(SINGLE_VALUED_DIMENSION).toBe("intensity");
    expect([...MULTI_VALUED_DIMENSIONS]).not.toContain("intensity");
    // Together the two lists cover every dimension exactly once — so a dimension
    // added later cannot be silently absent from both.
    expect([...MULTI_VALUED_DIMENSIONS, SINGLE_VALUED_DIMENSION].sort()).toEqual(
      [...PREFERENCE_DIMENSIONS].sort(),
    );
  });

  it("caps exactly the four set dimensions, and never intensity (§12.8)", () => {
    expect(Object.keys(PREFERENCE_LIMITS).sort()).toEqual([
      "note",
      "occasion",
      "scent_family",
      "season",
    ]);
    expect(PREFERENCE_LIMITS).toEqual({ scent_family: 10, note: 20, occasion: 6, season: 4 });
  });

  it("narrows a dimension string without accepting a near-miss", () => {
    expect(isPreferenceDimension("scent_family")).toBe(true);
    for (const near of ["scentFamily", "scent_families", "SCENT_FAMILY", "notes", ""]) {
      expect(isPreferenceDimension(near), near).toBe(false);
    }
  });
});

describe("server-owned vocabularies (§12.2)", () => {
  it("matches the design's scent_family, intensity, occasion and season lists verbatim", () => {
    expect([...PREFERENCE_VOCABULARY.scent_family]).toEqual([
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
    ]);
    expect([...PREFERENCE_VOCABULARY.intensity]).toEqual(["subtle", "balanced", "bold"]);
    expect([...PREFERENCE_VOCABULARY.occasion]).toEqual([
      "daily",
      "evening",
      "formal",
      "celebration",
      "gifting",
      "travel",
    ]);
    expect([...PREFERENCE_VOCABULARY.season]).toEqual(["spring", "summer", "autumn", "winter"]);
  });

  it("includes the five notes the design names explicitly", () => {
    // §12.2 gives "(rose, saffron, sandalwood, vanilla, bergamot, …)". The five are
    // specified; the remainder is a documented judgement call.
    for (const note of ["rose", "saffron", "sandalwood", "vanilla", "bergamot"]) {
      expect(PREFERENCE_VOCABULARY.note, note).toContain(note);
    }
  });

  it("holds no duplicate value in any dimension", () => {
    for (const dimension of PREFERENCE_DIMENSIONS) {
      const values = PREFERENCE_VOCABULARY[dimension];
      expect(new Set(values).size, dimension).toBe(values.length);
    }
  });

  it("fits every value in the column's 1..64 character CHECK", () => {
    for (const dimension of PREFERENCE_DIMENSIONS) {
      for (const value of PREFERENCE_VOCABULARY[dimension]) {
        expect(value.length, value).toBeGreaterThanOrEqual(1);
        expect(value.length, value).toBeLessThanOrEqual(64);
      }
    }
  });

  it("is frozen, so a handler cannot mutate the vocabulary for every later request", () => {
    expect(Object.isFrozen(PREFERENCE_VOCABULARY)).toBe(true);
    for (const dimension of PREFERENCE_DIMENSIONS) {
      expect(Object.isFrozen(PREFERENCE_VOCABULARY[dimension]), dimension).toBe(true);
    }
  });

  it("offers at least as many values as the cap allows, so a cap is reachable", () => {
    // A cap of 10 over a vocabulary of 6 would be a cap that can never be hit,
    // which would make the limit meaningless to the client rendering against it.
    for (const dimension of MULTI_VALUED_DIMENSIONS) {
      const cap = PREFERENCE_LIMITS[dimension];
      expect(PREFERENCE_VOCABULARY[dimension].length, dimension).toBeGreaterThanOrEqual(cap);
    }
  });
});

describe("communication defaults agree with the shipped migration (§14.2)", () => {
  it("mirrors every column DEFAULT in 1786200000000_create-communication-preferences", () => {
    // Read the migration rather than restating its values: this is the assertion
    // that the two copies of the defaults have not drifted, and it can only do
    // that by looking at the real file.
    const migration = readFileSync(
      fileURLToPath(
        new URL("../../migrations/1786200000000_create-communication-preferences.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const { key, column } of COMMUNICATION_COLUMNS) {
      const match = new RegExp(`${column}\\s+BOOLEAN NOT NULL DEFAULT (true|false)`).exec(migration);
      expect(match, `no DEFAULT found for ${column}`).not.toBeNull();
      const dbDefault = match?.[1] === "true";
      expect(COMMUNICATION_DEFAULTS[key], `${key} vs ${column}`).toBe(dbDefault);
    }
  });

  it("keeps promotional channels opt-IN and asked-for channels opt-OUT", () => {
    expect(COMMUNICATION_DEFAULTS).toEqual({
      productLaunches: false,
      restockAlerts: false,
      birthdayMessages: true,
      referralUpdates: true,
    });
  });

  it("carries NO marketing consent field (§13.1, Req 3.2)", () => {
    // Shopify owns consent. A key here would be a second source of truth for the
    // one value where disagreement is a compliance failure.
    expect(Object.keys(COMMUNICATION_DEFAULTS).sort()).toEqual([
      "birthdayMessages",
      "productLaunches",
      "referralUpdates",
      "restockAlerts",
    ]);
    expect(JSON.stringify(COMMUNICATION_DEFAULTS).toLowerCase()).not.toContain("consent");
    expect(JSON.stringify(COMMUNICATION_DEFAULTS).toLowerCase()).not.toContain("marketing");
  });

  it("carries NO push_enabled field, which is a reserved column and no contract", () => {
    expect(COMMUNICATION_COLUMNS.map((c) => c.column)).not.toContain("push_enabled");
  });

  it("covers exactly the keys the repository binds as parameters", () => {
    // The repository declares its own parameter order beside the statement it has
    // to match, rather than importing this list — see the comment on
    // `COMMUNICATION_PARAM_ORDER`. This is the assertion that the two cannot
    // diverge, so a fifth key added here cannot silently go unwritten.
    expect([...COMMUNICATION_PARAM_KEYS].sort()).toEqual(
      COMMUNICATION_COLUMNS.map((c) => c.key).sort(),
    );
  });
});

describe("validatePreferencesUpdate — accepting (§12.8)", () => {
  it("accepts the EMPTY body as a no-op rather than an error", () => {
    const update = updateOf({});
    expect(update.declared.size).toBe(0);
    expect(update.communication.size).toBe(0);
  });

  it("accepts any SUBSET of declared and communication", () => {
    const update = updateOf({ declared: { scent_family: ["oud"] } });
    expect([...update.declared.keys()]).toEqual(["scent_family"]);
    expect(update.communication.size).toBe(0);

    const comms = updateOf({ communication: { restockAlerts: true } });
    expect(comms.declared.size).toBe(0);
    expect([...comms.communication.entries()]).toEqual([["restockAlerts", true]]);
  });

  it("normalises a set into VOCABULARY order, not submitted order", () => {
    // The table has no ordering column, so a read cannot preserve submission order.
    // Normalising means a write and the read after it agree.
    const a = updateOf({ declared: { scent_family: ["woody", "oud", "amber"] } });
    const b = updateOf({ declared: { scent_family: ["amber", "woody", "oud"] } });
    expect(a.declared.get("scent_family")).toEqual(["oud", "amber", "woody"]);
    expect(a.declared.get("scent_family")).toEqual(b.declared.get("scent_family"));
  });

  it("accepts an EMPTY array as 'clear this dimension'", () => {
    const update = updateOf({ declared: { note: [] } });
    // Present with an empty value — distinct from absent, which means "untouched".
    expect(update.declared.has("note")).toBe(true);
    expect(update.declared.get("note")).toEqual([]);
  });

  it("accepts intensity as a single string and null as 'clear it'", () => {
    expect(updateOf({ declared: { intensity: "bold" } }).declared.get("intensity")).toEqual(["bold"]);
    expect(updateOf({ declared: { intensity: null } }).declared.get("intensity")).toEqual([]);
  });

  it("accepts exactly the cap, and refuses one more", () => {
    for (const dimension of MULTI_VALUED_DIMENSIONS) {
      const cap = PREFERENCE_LIMITS[dimension];
      const atCap = PREFERENCE_VOCABULARY[dimension].slice(0, cap);
      expect(updateOf({ declared: { [dimension]: atCap } }).declared.get(dimension)).toHaveLength(cap);
    }
    // One over the cap on the smallest dimension, using only real values so the
    // rejection is about the COUNT and not about an unknown value.
    const seasons = [...PREFERENCE_VOCABULARY.season, "spring"];
    expect(seasons.length).toBe(PREFERENCE_LIMITS.season + 1);
    expect(errorsOf({ declared: { season: seasons } })).toEqual([
      { field: "declared.season", code: "too_many_values" },
    ]);
  });

  it("accepts every value of every vocabulary", () => {
    for (const dimension of MULTI_VALUED_DIMENSIONS) {
      for (const value of PREFERENCE_VOCABULARY[dimension]) {
        expect(updateOf({ declared: { [dimension]: [value] } }).declared.get(dimension)).toEqual([
          value,
        ]);
      }
    }
    for (const value of PREFERENCE_VOCABULARY.intensity) {
      expect(updateOf({ declared: { intensity: value } }).declared.get("intensity")).toEqual([value]);
    }
  });
});

describe("validatePreferencesUpdate — rejecting with CODES, never sentences (Req 21.7)", () => {
  it("rejects a body that is not an object", () => {
    for (const body of ["hello", 42, [], null, true]) {
      expect(errorsOf(body), JSON.stringify(body)).toEqual([{ field: "body", code: "not_an_object" }]);
    }
  });

  it("NAMES an unknown top-level key rather than stripping it", () => {
    // Stripping would return 200 with the change not applied, and the client would
    // render the old value as though the save had worked.
    expect(errorsOf({ Declared: { note: [] } })).toEqual([
      { field: "Declared", code: "unknown_key" },
    ]);
  });

  it("NAMES an unknown dimension, including a plausible camelCase slip", () => {
    expect(errorsOf({ declared: { scentFamily: ["oud"] } })).toEqual([
      { field: "declared.scentFamily", code: "unknown_dimension" },
    ]);
  });

  it("REJECTS marketingConsent by name (§13.1, Req 13.4)", () => {
    // The important case. A 200 here would imply consent was recorded somewhere it
    // is not — Shopify owns it, through N9.
    expect(errorsOf({ communication: { marketingConsent: true } })).toEqual([
      { field: "communication.marketingConsent", code: "unknown_key" },
    ]);
  });

  it("REJECTS push_enabled, which has a column but no contract", () => {
    expect(errorsOf({ communication: { pushEnabled: true } })).toEqual([
      { field: "communication.pushEnabled", code: "unknown_key" },
    ]);
  });

  it("rejects an unknown VALUE inside a known dimension", () => {
    expect(errorsOf({ declared: { scent_family: ["plutonium"] } })).toEqual([
      { field: "declared.scent_family", code: "unknown_value" },
    ]);
    expect(errorsOf({ declared: { intensity: "overwhelming" } })).toEqual([
      { field: "declared.intensity", code: "unknown_value" },
    ]);
  });

  it("rejects a value from ANOTHER dimension's vocabulary", () => {
    // `winter` is real, but not a scent family. Cross-dimension leakage would let a
    // client store a value the UI for that dimension cannot render.
    expect(errorsOf({ declared: { scent_family: ["winter"] } })).toEqual([
      { field: "declared.scent_family", code: "unknown_value" },
    ]);
  });

  it("rejects a DUPLICATE value rather than letting the set silently absorb it", () => {
    expect(errorsOf({ declared: { season: ["spring", "spring"] } })).toEqual([
      { field: "declared.season", code: "duplicate_value" },
    ]);
  });

  it("rejects the wrong container shape per dimension", () => {
    expect(errorsOf({ declared: { scent_family: "oud" } })).toEqual([
      { field: "declared.scent_family", code: "not_an_array" },
    ]);
    // intensity is the mirror image: an array is refused because the dimension
    // holds one value, and accepting ["bold"] would make the wire shape ambiguous.
    expect(errorsOf({ declared: { intensity: ["bold"] } })).toEqual([
      { field: "declared.intensity", code: "not_a_string" },
    ]);
    expect(errorsOf({ declared: [] })).toEqual([{ field: "declared", code: "not_an_object" }]);
    expect(errorsOf({ communication: "yes" })).toEqual([
      { field: "communication", code: "not_an_object" },
    ]);
  });

  it("rejects a non-string inside a set and a non-boolean in communication", () => {
    expect(errorsOf({ declared: { note: [7] } })).toEqual([
      { field: "declared.note", code: "not_a_string" },
    ]);
    for (const bad of ["true", 1, null, {}]) {
      expect(errorsOf({ communication: { productLaunches: bad } }), JSON.stringify(bad)).toEqual([
        { field: "communication.productLaunches", code: "not_a_boolean" },
      ]);
    }
  });

  it("reports EVERY offending dimension, not just the first", () => {
    // A customer editing two dimensions at once should not have to submit twice to
    // discover the second problem.
    const errors = errorsOf({
      declared: { scent_family: ["plutonium"], note: "rose", season: ["spring", "spring"] },
    });
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.field)).toEqual([
      "declared.scent_family",
      "declared.note",
      "declared.season",
    ]);
  });

  it("produces error lists in the canonical dimension order, not the body's key order", () => {
    const a = errorsOf({ declared: { season: ["nope"], scent_family: ["nope"] } });
    const b = errorsOf({ declared: { scent_family: ["nope"], season: ["nope"] } });
    expect(a).toEqual(b);
    expect(a.map((e) => e.field)).toEqual(["declared.scent_family", "declared.season"]);
  });

  it("emits codes that are identifiers, never sentences", () => {
    const bodies: unknown[] = [
      "x",
      { nope: 1 },
      { declared: { scentFamily: [] } },
      { declared: { scent_family: ["nope"] } },
      { declared: { scent_family: "oud" } },
      { declared: { note: [1] } },
      { declared: { season: ["spring", "spring"] } },
      { declared: { season: [...PREFERENCE_VOCABULARY.season, "spring"] } },
      { declared: { intensity: 5 } },
      { communication: { productLaunches: "yes" } },
      { communication: { marketingConsent: true } },
    ];
    for (const body of bodies) {
      for (const error of errorsOf(body)) {
        expect(error.code, JSON.stringify(body)).toMatch(/^[a-z][a-z_]*$/);
        expect(error.field.length).toBeGreaterThan(0);
      }
    }
  });

  it("stores nothing when validation fails — the update is never partially built", () => {
    const result = validatePreferencesUpdate({
      declared: { scent_family: ["oud"], note: ["nope"] },
    });
    // `scent_family` was valid, but a rejected body applies NOTHING. Applying the
    // good half would be a partial save the customer did not ask for.
    expect(result.ok).toBe(false);
  });
});

describe("projectDeclared (§12.8)", () => {
  it("returns every dimension, empty rather than absent, for a customer with no rows", () => {
    expect(projectDeclared([])).toEqual({
      scent_family: [],
      note: [],
      intensity: null,
      occasion: [],
      season: [],
    });
  });

  it("projects intensity as a scalar, not a one-element array", () => {
    expect(projectDeclared([{ dimension: "intensity", value: "bold" }]).intensity).toBe("bold");
  });

  it("orders values by the vocabulary, independent of row order", () => {
    const rows = [
      { dimension: "scent_family", value: "woody" },
      { dimension: "scent_family", value: "oud" },
    ];
    // `oud` precedes `woody` in the vocabulary, so it precedes it in the output
    // whichever order the rows arrived in.
    expect(projectDeclared(rows).scent_family).toEqual(["oud", "woody"]);
    expect(projectDeclared([...rows].reverse()).scent_family).toEqual(["oud", "woody"]);
  });

  it("DROPS a stored value outside the vocabulary rather than surfacing it", () => {
    // Should be unreachable — the write validates and the column has a CHECK. But
    // returning it would hand the client an option it can neither render nor unset.
    const projected = projectDeclared([
      { dimension: "scent_family", value: "oud" },
      { dimension: "scent_family", value: "plutonium" },
    ]);
    expect(projected.scent_family).toEqual(["oud"]);
  });

  it("DROPS a stored row whose dimension is unknown", () => {
    expect(projectDeclared([{ dimension: "vibe", value: "oud" }])).toEqual({
      scent_family: [],
      note: [],
      intensity: null,
      occasion: [],
      season: [],
    });
  });
});

describe("projectCommunication (§14.2)", () => {
  it("applies defaults when the customer has NO row — absence is normal, not a 404", () => {
    expect(projectCommunication(null)).toEqual(COMMUNICATION_DEFAULTS);
  });

  it("maps every snake_case column to its camelCase wire key", () => {
    expect(
      projectCommunication({
        product_launches: true,
        restock_alerts: true,
        birthday_messages: false,
        referral_updates: false,
      }),
    ).toEqual({
      productLaunches: true,
      restockAlerts: true,
      birthdayMessages: false,
      referralUpdates: false,
    });
  });

  it("returns a COPY of the defaults, so a caller cannot mutate them for everyone", () => {
    const first = projectCommunication(null) as { productLaunches: boolean };
    first.productLaunches = true;
    expect(projectCommunication(null).productLaunches).toBe(false);
  });

  it("exposes exactly the four contract keys and no column beyond them", () => {
    const keys = Object.keys(
      projectCommunication({
        product_launches: false,
        restock_alerts: false,
        birthday_messages: true,
        referral_updates: true,
      }),
    ).sort();
    expect(keys).toEqual(["birthdayMessages", "productLaunches", "referralUpdates", "restockAlerts"]);
  });
});

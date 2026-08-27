/**
 * `userErrors[]` → closed code set — task 14.1, §13.4, Req 2.7, 5.4, 20.7, 20.8.
 *
 * SAFETY: pure functions only. No network, no database, no production.
 */
import { describe, expect, it } from "vitest";
import {
  assertNoPortalWriteErrors,
  mapUserError,
  mapUserErrors,
  PORTAL_WRITE_FIELD_CODES,
  PortalWriteRejectedError,
} from "./userErrorCodes.js";

describe("the closed code set (§13.4)", () => {
  it("holds exactly the six codes the design lists, in order", () => {
    expect([...PORTAL_WRITE_FIELD_CODES]).toEqual([
      "invalid_phone",
      "invalid_postcode",
      "invalid_country",
      "required",
      "too_long",
      "rejected",
    ]);
  });

  it("emits only identifiers, never sentences", () => {
    for (const code of PORTAL_WRITE_FIELD_CODES) {
      expect(code).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe("field-driven mapping (Shopify's base UserError carries no code)", () => {
  it("maps a phone field to invalid_phone, whatever the argument prefix", () => {
    // `customerUpdate` prefixes with `input`, `customerAddressUpdate` with
    // `address` — keying on the LEAF is what lets one table serve both.
    for (const field of [["phone"], ["input", "phone"], ["address", "phone"]]) {
      expect(mapUserError({ field, message: "Phone is invalid" }).code, field.join(".")).toBe(
        "invalid_phone",
      );
    }
  });

  it("maps every postcode spelling Shopify uses to invalid_postcode", () => {
    for (const leaf of ["zip", "postcode", "postalCode", "ZIP"]) {
      expect(mapUserError({ field: ["address", leaf] }).code, leaf).toBe("invalid_postcode");
    }
  });

  it("maps every country spelling to invalid_country", () => {
    for (const leaf of ["country", "countryCode", "countryCodeV2"]) {
      expect(mapUserError({ field: ["address", leaf] }).code, leaf).toBe("invalid_country");
    }
  });

  it("returns the field LEAF, so a client can attach the error to its input", () => {
    expect(mapUserError({ field: ["input", "phone"] }).field).toBe("phone");
    expect(mapUserError({ field: ["address", "zip"] }).field).toBe("zip");
  });

  it("falls back to rejected for an unmapped field, which is a real answer", () => {
    expect(mapUserError({ field: ["address", "address1"] })).toEqual({
      field: "address1",
      code: "rejected",
    });
  });

  it("handles an error naming NO field", () => {
    for (const field of [null, undefined, []]) {
      expect(mapUserError({ field: field as never })).toEqual({ field: null, code: "rejected" });
    }
  });

  it("ignores a blank or non-string field segment rather than emitting an empty name", () => {
    expect(mapUserError({ field: ["input", "   "] }).field).toBeNull();
    expect(mapUserError({ field: ["input", 7 as never] }).field).toBeNull();
  });
});

describe("Shopify's own code, where it supplies one", () => {
  it("maps MISSING_ARGUMENT to required, OVERRIDING the field table", () => {
    // "you did not supply this" is a stronger statement than "something about phone
    // is wrong" — a missing phone should read as `required`, not `invalid_phone`.
    expect(mapUserError({ field: ["input", "phone"], code: "MISSING_ARGUMENT" }).code).toBe(
      "required",
    );
  });

  it("maps the length codes to too_long", () => {
    for (const code of ["TOO_LONG", "TOO_BIG"]) {
      expect(mapUserError({ field: ["input", "firstName"], code }).code, code).toBe("too_long");
    }
  });

  it("is case-insensitive on Shopify's code", () => {
    expect(mapUserError({ field: ["x"], code: "missing_argument" }).code).toBe("required");
  });

  it("does NOT map INVALID or INCLUSION centrally, so the field stays the signal", () => {
    // Both say "this value is wrong" without saying how, so the field is more
    // informative and a central mapping would override it.
    expect(mapUserError({ field: ["address", "zip"], code: "INVALID" }).code).toBe(
      "invalid_postcode",
    );
    expect(mapUserError({ field: ["address", "countryCode"], code: "INCLUSION" }).code).toBe(
      "invalid_country",
    );
    // With no recognisable field either, it degrades to `rejected`.
    expect(mapUserError({ field: ["address", "address2"], code: "INVALID" }).code).toBe("rejected");
  });

  it("maps the CustomerEmailMarketingConsentUpdateUserError enum values it should", () => {
    // The live enum is INVALID, INCLUSION, INTERNAL_ERROR, MISSING_ARGUMENT.
    expect(mapUserError({ field: null, code: "MISSING_ARGUMENT" }).code).toBe("required");
    for (const code of ["INVALID", "INCLUSION", "INTERNAL_ERROR"]) {
      expect(mapUserError({ field: null, code }).code, code).toBe("rejected");
    }
  });
});

describe("Shopify's message text is NEVER forwarded (§5.5, §13.4)", () => {
  it("drops the message from every mapped error", () => {
    const mapped = mapUserErrors([
      { field: ["input", "phone"], message: "Phone number is not a valid phone number" },
      { field: ["address", "zip"], message: "Zip ist ungültig" },
    ]);
    const serialised = JSON.stringify(mapped);
    expect(serialised).not.toContain("valid phone number");
    expect(serialised).not.toContain("ungültig");
    // Only `field` and `code` survive.
    for (const entry of mapped) {
      expect(Object.keys(entry).sort()).toEqual(["code", "field"]);
    }
  });

  it("keeps no message on the thrown error either", () => {
    let caught: PortalWriteRejectedError | null = null;
    try {
      assertNoPortalWriteErrors([{ field: ["input", "phone"], message: "SECRET-UPSTREAM-TEXT" }]);
    } catch (err) {
      caught = err as PortalWriteRejectedError;
    }
    expect(caught).toBeInstanceOf(PortalWriteRejectedError);
    expect(JSON.stringify(caught?.fields)).not.toContain("SECRET-UPSTREAM-TEXT");
    // A constant message, so even a handler that logged `err.message` leaks nothing.
    expect(caught?.message).toBe("Shopify refused the write.");
  });
});

describe("mapUserErrors over an array", () => {
  it("returns empty for no errors, and for a null or absent array", () => {
    expect(mapUserErrors([])).toEqual([]);
    expect(mapUserErrors(null)).toEqual([]);
    expect(mapUserErrors(undefined)).toEqual([]);
  });

  it("PRESERVES order, because a client renders fields in the order shown", () => {
    const mapped = mapUserErrors([
      { field: ["address", "zip"] },
      { field: ["address", "phone"] },
      { field: ["address", "countryCode"] },
    ]);
    expect(mapped.map((m) => m.code)).toEqual([
      "invalid_postcode",
      "invalid_phone",
      "invalid_country",
    ]);
  });

  it("DEDUPLICATES nothing — two errors on one field are two things to fix", () => {
    const mapped = mapUserErrors([{ field: ["address", "zip"] }, { field: ["address", "zip"] }]);
    expect(mapped).toHaveLength(2);
  });

  it("only ever emits codes from the closed set", () => {
    const mapped = mapUserErrors([
      { field: ["a", "b"], code: "SOMETHING_NEW_SHOPIFY_ADDED" },
      { field: ["zip"] },
      { field: null, code: null },
    ]);
    for (const entry of mapped) {
      expect(PORTAL_WRITE_FIELD_CODES).toContain(entry.code);
    }
  });
});

describe("assertNoPortalWriteErrors", () => {
  it("does nothing when there are no errors", () => {
    expect(() => assertNoPortalWriteErrors([])).not.toThrow();
    expect(() => assertNoPortalWriteErrors(null)).not.toThrow();
    expect(() => assertNoPortalWriteErrors(undefined)).not.toThrow();
  });

  it("throws with the mapped fields when there are", () => {
    expect(() => assertNoPortalWriteErrors([{ field: ["input", "phone"] }])).toThrow(
      PortalWriteRejectedError,
    );
  });

  it("carries the invalid_request code so the route maps it to 400", () => {
    try {
      assertNoPortalWriteErrors([{ field: ["address", "zip"] }]);
    } catch (err) {
      expect((err as PortalWriteRejectedError).code).toBe("invalid_request");
      expect((err as PortalWriteRejectedError).fields).toEqual([
        { field: "zip", code: "invalid_postcode" },
      ]);
    }
  });

  it("never produces an EMPTY field list, which would name nothing", () => {
    // A 400 saying "something was wrong" without naming it is unactionable.
    const err = new PortalWriteRejectedError([]);
    expect(err.fields).toEqual([{ field: null, code: "rejected" }]);
  });
});

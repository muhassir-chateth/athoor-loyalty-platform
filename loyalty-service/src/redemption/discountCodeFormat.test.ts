/**
 * Unit tests for the discount-code format + generator (task 5.3).
 *
 * Pure computation, no I/O. Verifies the `ATH-XXXX-XXXX` shape, that generated
 * codes only use the unambiguous alphabet, and that an injected deterministic
 * random source produces a predictable code (used by the worker tests).
 */
import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_PREFIX,
  generateCandidateCode,
  isValidCodeFormat,
  type RandomInt,
} from "./discountCodeFormat.js";

describe("generateCandidateCode", () => {
  it("produces a well-formed ATH-XXXX-XXXX code", () => {
    const code = generateCandidateCode();
    expect(isValidCodeFormat(code)).toBe(true);
    expect(code.startsWith(`${CODE_PREFIX}-`)).toBe(true);
    expect(code).toHaveLength(3 + 1 + 4 + 1 + 4); // ATH + - + XXXX + - + XXXX
  });

  it("only uses characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const body = generateCandidateCode().replace(/^ATH-/, "").replace("-", "");
      for (const ch of body) {
        expect(CODE_ALPHABET.includes(ch)).toBe(true);
      }
    }
  });

  it("is deterministic given a deterministic random source", () => {
    // Always pick index 0 → first alphabet char 'A' in every position.
    const zero: RandomInt = () => 0;
    expect(generateCandidateCode(zero)).toBe("ATH-AAAA-AAAA");
  });
});

describe("isValidCodeFormat", () => {
  it("accepts a canonical code and rejects malformed ones", () => {
    expect(isValidCodeFormat("ATH-9F3K-2QX7")).toBe(true);
    expect(isValidCodeFormat("ath-9f3k-2qx7")).toBe(false); // lowercase
    expect(isValidCodeFormat("ATH-9F3K")).toBe(false); // missing segment
    expect(isValidCodeFormat("ATH-9F3K-2QX70")).toBe(false); // too long
    expect(isValidCodeFormat("ATH-0O1I-2QX7")).toBe(false); // ambiguous chars excluded
    expect(isValidCodeFormat("XXX-9F3K-2QX7")).toBe(false); // wrong prefix
  });
});

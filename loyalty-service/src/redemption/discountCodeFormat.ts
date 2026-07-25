/**
 * Discount-code format + crypto-random generator (task 5.3).
 *
 * The Admin Gateway mints codes in the format `ATH-XXXX-XXXX` where each `X` is
 * a crypto-random character (design.md "Outbound: single-use discount codes":
 * `Code format ATH-XXXX-XXXX (crypto-random, collision-checked against
 * discount_codes.code)`). This module owns ONLY the format and the random
 * generation; the collision check against `discount_codes.code` lives in the
 * worker (`generateDiscountCode.ts`) because it needs the database.
 *
 * Randomness comes from Node's CSPRNG (`crypto.randomInt`) — never `Math.random`
 * — so codes are unguessable, which matters because a code is a bearer token
 * for money off (single-use, customer-bound though it is).
 *
 * SAFETY: pure computation + local CSPRNG. Touches no database, no network, no
 * Shopify API.
 */
import { randomInt } from "node:crypto";

/** The fixed brand prefix on every Athoor discount code. */
export const CODE_PREFIX = "ATH" as const;

/** Number of random characters in each of the two segments after the prefix. */
export const SEGMENT_LENGTH = 4 as const;

/**
 * The alphabet random characters are drawn from: A–Z and 2–9, excluding the
 * visually ambiguous `0`, `O`, `1`, and `I` so codes are safe to read aloud or
 * copy from an email. 32 symbols → 5 bits of entropy per character.
 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" as const;

/** Matches a well-formed code: `ATH-XXXX-XXXX` over {@link CODE_ALPHABET}. */
export const CODE_PATTERN = new RegExp(
  `^${CODE_PREFIX}-[${CODE_ALPHABET}]{${SEGMENT_LENGTH}}-[${CODE_ALPHABET}]{${SEGMENT_LENGTH}}$`,
);

/** A source of a single random integer in `[0, maxExclusive)`; injectable for tests. */
export type RandomInt = (maxExclusive: number) => number;

/** Default CSPRNG-backed integer source. */
const cryptoRandomInt: RandomInt = (maxExclusive) => randomInt(maxExclusive);

/** Builds one random segment of {@link SEGMENT_LENGTH} characters from the alphabet. */
function randomSegment(rand: RandomInt): string {
  let out = "";
  for (let i = 0; i < SEGMENT_LENGTH; i++) {
    out += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates one candidate code `ATH-XXXX-XXXX` using the given random source
 * (defaults to the CSPRNG). This is a CANDIDATE only — the caller must still
 * check it against `discount_codes.code` for collisions before use.
 */
export function generateCandidateCode(rand: RandomInt = cryptoRandomInt): string {
  return `${CODE_PREFIX}-${randomSegment(rand)}-${randomSegment(rand)}`;
}

/** True iff `code` is a syntactically valid `ATH-XXXX-XXXX` code. */
export function isValidCodeFormat(code: string): boolean {
  return typeof code === "string" && CODE_PATTERN.test(code);
}

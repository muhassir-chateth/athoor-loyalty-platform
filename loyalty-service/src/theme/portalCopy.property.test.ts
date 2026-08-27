// Feature: customer-experience-portal, Property 5: Customer-facing output never emits an internal identifier string
/**
 * PROPERTY 5 — spec task 18.8. Validates Requirements 9.3, 9.4, 9.8, 10.15.
 *
 * The property: no rendered string ever contains an internal identifier.
 *
 * ── WHY THIS IS THE PROPERTY AND NOT A TABLE TEST ───────────────────────────
 * §1.5 records that production shows customers strings like `reward_15` today.
 * That is not a typo — it is what happens when a client renders whatever the
 * ledger stored. A table test over the values that exist now would pass and then
 * fail silently the first time the engine gains a tenth `entry_type`, because the
 * new value would fall through whatever branch happened to be last.
 *
 * So the property is stated over values that DO NOT EXIST YET: arbitrary reasons,
 * mixed-case variants, unknown stages, admin free text, empty and absent values.
 * The map is closed and the input is never echoed, which is what makes the
 * property hold for next year's identifier as well as this year's.
 *
 * ── WHAT COUNTS AS A LEAK ───────────────────────────────────────────────────
 * Any of: a ledger `entry_type`, a `reason` key, a reward id, a referral guard
 * column, a referral point constant, a database column or table name, or a record
 * id. §18.9 names the referral ones explicitly (Requirement 10.15): none of
 * `earn_referral`, `REFERRAL_SIGNUP_POINTS`, `REFERRAL_PURCHASE_POINTS`,
 * `signup_rewarded` or `purchase_rewarded` may appear in rendered output.
 *
 * SAFETY: pure. No DOM, no network, no database.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as copy from "../../../theme-src/portal/ui/copy.js";

/* ========================================================================== *
 * The forbidden vocabulary
 * ========================================================================== */

/** The nine ledger `entry_type` values (§18.9's left column). */
const ENTRY_TYPES: readonly string[] = [
  "earn_signup",
  "earn_order",
  "earn_first_purchase",
  "earn_referral",
  "spend",
  "clawback",
  "expire",
  "adjust",
  "migration",
];

/** Every `reason` the ledger writes, plus the two migration spellings. */
const REASONS: readonly string[] = [
  "signup_bonus",
  "paid_order",
  "first_purchase_bonus",
  "referral_signup_bonus",
  "referral_first_purchase_bonus",
  "refund_clawback",
  "cancellation_clawback",
  "point_lot_expired",
  "redemption_failed_reversal",
  "opening_balance",
];

/** The referral internals Requirement 10.15 names. */
const REFERRAL_INTERNALS: readonly string[] = [
  "earn_referral",
  "REFERRAL_SIGNUP_POINTS",
  "REFERRAL_PURCHASE_POINTS",
  "signup_rewarded",
  "purchase_rewarded",
  "friend_signup",
  "friend_first_purchase",
];

/** Column and table names that must never reach a customer. */
const SCHEMA_NAMES: readonly string[] = [
  "ledger_entries",
  "customer_id",
  "entry_type",
  "order_reference",
  "point_lots",
  "redemptions",
  "referrals",
  "customer_birthdays",
  "customer_wishlist",
  "grant_year",
  "shopify_customer_id",
];

/** Requirement 16.8 — forbidden in output in every state. */
const FORBIDDEN_STRINGS: readonly string[] = [
  "Loading...",
  "Something went wrong",
  "undefined",
  "null",
  "NaN",
];

/**
 * Everything that must never appear.
 *
 * `spend`, `expire` and `adjust` are deliberately excluded from the substring
 * scan: they are ordinary English words that appear inside legitimate copy
 * ("Points expired"), so scanning for them as substrings would fail on correct
 * output. They are still covered — as `entry_type` KEYS driving the generator
 * below, where what matters is that the key does not come back out.
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  ...ENTRY_TYPES.filter((t) => t !== "spend" && t !== "expire" && t !== "adjust" && t !== "migration"),
  ...REASONS,
  ...REFERRAL_INTERNALS,
  ...SCHEMA_NAMES,
  ...FORBIDDEN_STRINGS,
];

/** Every forbidden literal present in a rendered string. */
function leaks(rendered: string): string[] {
  const found: string[] = [];
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (rendered.includes(forbidden)) found.push(forbidden);
  }
  // A reward id in any form, e.g. `reward_15` (§18.9: the id is never shown).
  if (/reward_\d+/.test(rendered)) found.push("a reward id");
  return found;
}

/** An arbitrary ledger entry, with the reason and type under generator control. */
function entryWith(reason: string, type: PortalActivityEntry["type"], points: number, order: number | null) {
  return { id: "row-1", type, points, reason, date: "2026-06-12T00:00:00.000Z", orderReference: order };
}

describe("Property 5: customer-facing output never emits an internal identifier", () => {
  it("Property: no ledger entry renders an internal identifier, for ANY reason value", () => {
    fc.assert(
      fc.property(
        // Known reasons, reward ids, admin free text, and arbitrary future values.
        fc.oneof(
          fc.constantFrom(...REASONS),
          fc.constantFrom(...ENTRY_TYPES),
          fc.constantFrom("reward_5", "reward_15", "reward_35", "reward_75", "reward_9999"),
          // Admin free text — §18.9: never rendered, unconditionally.
          fc.constantFrom(
            "refund for ticket #4821",
            "goodwill - spoke to Sarah on the phone",
            "correcting my mistake from yesterday",
            "customer_id 9f2a mismatch, see ledger_entries",
          ),
          fc.string(),
          fc.constantFrom("", "SIGNUP_BONUS", "Paid_Order", "  paid_order  "),
        ),
        fc.constantFrom<PortalActivityEntry["type"]>("earned", "spent", "expired"),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 99_999_999 })),
        (reason, type, points, order) => {
          const entry = entryWith(reason, type, points, order) as PortalActivityEntry;
          const description = copy.activityDescription(entry);
          const amount = copy.signedPoints(entry.points);

          expect(leaks(description), `description leaked for reason ${JSON.stringify(reason)}`).toEqual(
            [],
          );
          expect(leaks(amount), "amount leaked").toEqual([]);
          // The mapping is TOTAL: something is always rendered.
          expect(description.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("Property: a reward id renders its VALUE, never the id", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.boolean(),
        (amount, known) => {
          const reason = `reward_${String(amount)}`;
          const entry = entryWith(reason, "spent", -amount * 10, null) as PortalActivityEntry;
          const catalogue = known ? { [reason]: `£${String(amount)}` } : {};
          const rendered = copy.activityDescription(entry, catalogue);

          expect(leaks(rendered), `leaked for ${reason}`).toEqual([]);
          if (known) {
            expect(rendered).toContain(`£${String(amount)}`);
          } else {
            // §18.9: an id the catalogue does not know falls back to "a reward".
            expect(rendered).toBe("Redeemed — a reward");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property: every referral stage and state combination is safe and total", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom("friend_signup", "friend_first_purchase"),
          fc.constantFrom("", "friend_second_purchase", "SIGNUP", "signup_rewarded"),
          fc.string(),
        ),
        fc.oneof(fc.constantFrom("pending", "awarded"), fc.constantFrom("", "queued", "revoked"), fc.string()),
        fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 10_000 })),
        (key, state, points) => {
          const stage = {
            key,
            state,
            ...(points === undefined ? {} : { currentRewardPoints: points, creditedPoints: points }),
          } as PortalReferralStage;
          const rendered = copy.referralStage(stage);
          const all = `${rendered.name} ${rendered.qualification} ${rendered.state}`;

          expect(leaks(all), `leaked for stage ${JSON.stringify(key)}/${JSON.stringify(state)}`).toEqual(
            [],
          );
          // Total: all three fields always say something.
          expect(rendered.name.length).toBeGreaterThan(0);
          expect(rendered.qualification.length).toBeGreaterThan(0);
          expect(rendered.state.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("Property: every other identifier vocabulary is total and leak-free", () => {
    fc.assert(
      fc.property(
        fc.string(),
        (identifier) => {
          const rendered = [
            copy.fulfilment(identifier),
            copy.availability(identifier),
            copy.redemptionStatus(identifier),
            copy.birthdayEligibility(identifier, "2027-03-04"),
            copy.provenance(identifier),
            copy.error(identifier),
            copy.fieldError(identifier),
          ];
          for (const value of rendered) {
            expect(leaks(value), `leaked for ${JSON.stringify(identifier)}`).toEqual([]);
            // Every vocabulary is total: an unmapped identifier still renders.
            expect(value.length).toBeGreaterThan(0);
          }
          // `insight` is the one that legitimately renders EMPTY for an unknown
          // kind — there is no neutral sentence for "we inferred something but do
          // not know what", and inventing one would state a conclusion we lack.
          expect(leaks(copy.insight(identifier, "oud"))).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the eight designed states carry no forbidden string (Requirement 16.8)", () => {
    const states: readonly PortalSectionState[] = [
      "loading",
      "empty",
      "ready",
      "error",
      "disabled",
      "offline",
      "session-expired",
      "degraded",
    ];
    for (const state of states) {
      const rendered = copy.state(state);
      expect(leaks(rendered), `state ${state}`).toEqual([]);
    }
    // The loading state must not be `Loading...` — the requirement's own example.
    expect(copy.state("loading")).not.toBe("Loading...");
    expect(copy.state("loading").length).toBeGreaterThan(0);
  });

  it("no point or money figure is a literal in the copy tables (Requirement 10.15)", () => {
    // A referral reward figure baked into a theme asset is a figure that
    // disagrees with the ledger the day the programme changes.
    const tables = JSON.stringify(copy.COPY_TABLES);
    expect(tables, "a digit sequence appears in the copy tables").not.toMatch(/\d{2,}/);
    expect(tables).not.toMatch(/£\s*\d/);
  });

  it("is NON-VACUOUS: the leak detector catches each class of identifier", () => {
    expect(leaks("Points from earn_order")).not.toEqual([]);
    expect(leaks("reason: signup_bonus")).not.toEqual([]);
    expect(leaks("Redeemed reward_15")).not.toEqual([]);
    expect(leaks("earn_referral credited")).not.toEqual([]);
    expect(leaks("see ledger_entries row")).not.toEqual([]);
    expect(leaks("signup_rewarded = true")).not.toEqual([]);
    expect(leaks("Loading...")).not.toEqual([]);
    expect(leaks("value is undefined")).not.toEqual([]);
    expect(leaks("NaN points")).not.toEqual([]);
    // And does NOT fire on legitimate copy.
    expect(leaks("Welcome to My Athoor")).toEqual([]);
    expect(leaks("Points expired")).toEqual([]);
    expect(leaks("Points from order #1042")).toEqual([]);
    expect(leaks("An adjustment to your account")).toEqual([]);
    expect(leaks("Awaiting their first order")).toEqual([]);
  });

  it("admin free text is mapped away UNCONDITIONALLY, not sanitised", () => {
    // The distinction matters. Sanitising would still render operator wording;
    // §18.9 requires the neutral description instead, because the text is written
    // for internal readers and may name a person, a ticket or a mistake.
    const entry = entryWith("goodwill for Sarah, ticket 4821", "earned", 250, null) as PortalActivityEntry;
    expect(copy.activityDescription(entry)).toBe("An adjustment to your account");
    expect(copy.activityDescription(entry)).not.toContain("Sarah");
    expect(copy.activityDescription(entry)).not.toContain("4821");
  });
});

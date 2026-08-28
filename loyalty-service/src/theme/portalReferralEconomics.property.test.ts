// Feature: customer-experience-portal, Property 11: Referral economics change without a theme change
// @vitest-environment jsdom
/**
 * PROPERTY 11 — spec task 23.3. Validates Requirements 10.11, 10.12, 10.13, 10.16.
 *
 * The property: the referral programme's economics can change to ANY value, and the
 * customer sees the new value, without a single byte of any theme asset changing.
 *
 * ── WHY THIS IS THE STRONGEST AVAILABLE STATEMENT ───────────────────────────
 * The requirement people reach for first is "no theme asset contains the number
 * 150". That is necessary but weak: it is satisfied by an asset that contains `140`
 * instead, and it cannot be stated over arbitrary values at all, because a scan for
 * an arbitrary integer over every theme asset matches `100%` in a CSS width, `2` in
 * a `z-index` and `64` in a `maxlength`. Generating integers and grepping for them
 * would produce a test that fails for reasons having nothing to do with referral
 * economics — and a test that is noisy gets its assertion loosened.
 *
 * So the property is stated the other way round, over the rendering FUNCTION:
 *
 *   for any two distinct configurations A and B, rendering the same stage under A
 *   and under B produces DIFFERENT output, while the asset bytes are identical.
 *
 * A literal cannot survive that. If the figure were baked into the asset, output
 * under A and B would be the same — the property fails immediately and for the right
 * reason. This is the difference between checking that today's number is absent and
 * proving that no number is present.
 *
 * The byte-identity half is measured, not assumed: every built portal asset is
 * hashed before the property runs and again afterwards, and the two digests must
 * match. That is what "without a theme deployment" means operationally.
 *
 * ── AND ONE SCAN THAT *IS* MEANINGFUL ───────────────────────────────────────
 * Separately from the property, the REAL configured figures are scanned for in the
 * referral-owned assets only. Scoped that way there are no false positives, and it
 * is a genuine gate: it is the assertion that would have caught the literal `150`
 * that an explanatory comment in the Liquid arm briefly contained.
 *
 * ── REQUIREMENT 10.16 IS THE SUBTLE ONE ─────────────────────────────────────
 * An AWARDED stage must render what the ledger actually paid, not today's configured
 * amount. So the property also asserts that changing the configuration moves a
 * PENDING stage's figure and leaves an AWARDED stage's figure alone. A customer who
 * earned an award under the old economics is owed the number they were credited;
 * restating history to match the current configuration would be a quiet lie.
 *
 * SAFETY: pure plus file reads. No DOM, no network, no database.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import { stageRow } from "../../../theme-src/portal/render/rows.js";

/* ========================================================================== *
 * The assets under inspection
 * ========================================================================== */

const THEME_ASSETS = join(import.meta.dirname, "..", "..", "..", "theme", "assets");
const THEME_SNIPPETS = join(import.meta.dirname, "..", "..", "..", "theme", "snippets");
const PORTAL_STYLES = join(import.meta.dirname, "..", "..", "..", "theme-src", "portal", "styles", "sections");
const PORTAL_SECTIONS = join(import.meta.dirname, "..", "..", "..", "theme-src", "portal", "sections");

/** Every built portal asset, which is what a theme deployment would ship. */
function portalAssetFiles(): readonly string[] {
  return readdirSync(THEME_ASSETS)
    .filter((name) => name.startsWith("athoor-portal"))
    .sort();
}

/** One digest over every built portal asset, order-stable. */
function portalAssetDigest(): string {
  const hash = createHash("sha256");
  for (const name of portalAssetFiles()) {
    hash.update(name);
    hash.update(readFileSync(join(THEME_ASSETS, name)));
  }
  return hash.digest("hex");
}

/**
 * The files that carry the referral surface.
 *
 * Deliberately narrow. Requirement 10.11 names "a Liquid template, a CSS file, or
 * client-side JavaScript" for the referral section, and scanning unrelated assets
 * for a two-digit number is how a gate becomes noise.
 */
function referralOwnedSources(): readonly { name: string; text: string }[] {
  return [
    { name: "theme/assets/athoor-portal-referrals.js", text: readFileSync(join(THEME_ASSETS, "athoor-portal-referrals.js"), "utf8") },
    { name: "theme-src/portal/sections/referrals.ts", text: readFileSync(join(PORTAL_SECTIONS, "referrals.ts"), "utf8") },
    { name: "theme-src/portal/styles/sections/referrals.css", text: readFileSync(join(PORTAL_STYLES, "referrals.css"), "utf8") },
    { name: "theme/snippets/portal-section.liquid#referrals", text: referralsLiquidArm() },
  ];
}

/** Just the `{%- when 'referrals' -%}` arm, so other sections' numbers are out of scope. */
function referralsLiquidArm(): string {
  const whole = readFileSync(join(THEME_SNIPPETS, "portal-section.liquid"), "utf8");
  const start = whole.indexOf("{%- when 'referrals' -%}");
  expect(start, "the referrals arm is missing from portal-section.liquid").toBeGreaterThan(-1);
  const after = whole.indexOf("{%- when ", start + 1);
  const end = after === -1 ? whole.indexOf("{%- endcase -%}", start) : after;
  return whole.slice(start, end === -1 ? undefined : end);
}

/** The programme's real configured figures — the service is the single source. */
const CONFIGURED_SIGNUP_POINTS = 150;
const CONFIGURED_PURCHASE_POINTS = 250;

/* ========================================================================== *
 * Generators
 * ========================================================================== */

/**
 * Reward amounts across the three regions the task names: zero, the values
 * configured today, and arbitrary positive integers.
 */
const rewardAmount = fc.oneof(
  fc.constant(0),
  fc.constant(CONFIGURED_SIGNUP_POINTS),
  fc.constant(CONFIGURED_PURCHASE_POINTS),
  fc.integer({ min: 1, max: 1_000_000 }),
);

const stageKey = fc.constantFrom("friend_signup", "friend_first_purchase");
const stageState = fc.constantFrom("awarded", "pending", "none");

/** A rendered stage's points cell, which is where every figure surfaces. */
function renderPoints(stage: PortalReferralStage): string {
  const template = document.createElement("template");
  template.innerHTML =
    '<li><span data-slot="name"></span><span data-slot="qualification"></span>' +
    '<span data-slot="state"></span><span data-slot="points"></span></li>';
  const fragment = stageRow(stage, template);
  return fragment.querySelector("[data-slot='points']")?.textContent ?? "";
}

describe("Property 11: referral economics change without a theme change", () => {
  it("a PENDING stage's figure follows the configuration, so no literal can exist", () => {
    const before = portalAssetDigest();

    fc.assert(
      fc.property(stageKey, rewardAmount, rewardAmount, (key, configA, configB) => {
        // Two distinct configurations only: identical configurations must of course
        // render identically, and asserting otherwise would be nonsense.
        fc.pre(configA !== configB);

        const under = (currentRewardPoints: number): string =>
          renderPoints({ key, state: "pending", currentRewardPoints, creditedPoints: 0 });

        // THE PROPERTY. A baked-in figure would make these equal.
        expect(under(configA)).not.toBe(under(configB));
        // And each states its own configuration's value.
        expect(under(configA)).toContain(String(configA));
        expect(under(configB)).toContain(String(configB));
      }),
      { numRuns: 300 },
    );

    // "Without a theme deployment", measured rather than asserted.
    expect(portalAssetDigest(), "a theme asset changed while the property ran").toBe(before);
  });

  it("an AWARDED stage's credited figure is IMMUNE to a later change (Req 10.16)", () => {
    fc.assert(
      fc.property(stageKey, rewardAmount, rewardAmount, rewardAmount, (key, credited, configA, configB) => {
        fc.pre(configA !== configB);
        // The ledger paid `credited`. Two later reconfigurations must not touch it.
        const underA = renderPoints({ key, state: "awarded", creditedPoints: credited, currentRewardPoints: configA });
        const underB = renderPoints({ key, state: "awarded", creditedPoints: credited, currentRewardPoints: configB });
        expect(underA).toBe(underB);
        expect(underA).toContain(String(credited));
      }),
      { numRuns: 300 },
    );
  });

  it("holds across EVERY awarded/pending/none combination of the two stages", () => {
    fc.assert(
      fc.property(
        stageState,
        stageState,
        rewardAmount,
        rewardAmount,
        rewardAmount,
        (stateA, stateB, credited, configA, configB) => {
          fc.pre(configA !== configB);
          const build = (state: string, current: number): PortalReferralStage[] => [
            { key: "friend_signup", state, creditedPoints: credited, currentRewardPoints: current },
            { key: "friend_first_purchase", state: stateB, creditedPoints: credited, currentRewardPoints: current },
          ];
          const a = build(stateA, configA).map(renderPoints).join("|");
          const b = build(stateA, configB).map(renderPoints).join("|");

          // An awarded stage is pinned to `credited`, so when BOTH stages are
          // awarded the output is legitimately identical. Every other combination
          // has at least one cell that must move with the configuration.
          const bothPinned = stateA === "awarded" && stateB === "awarded";
          if (bothPinned) expect(a).toBe(b);
          else expect(a).not.toBe(b);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("renders no internal identifier for any stage key or state (Requirement 10.15)", () => {
    const forbidden = [
      "earn_referral",
      "REFERRAL_SIGNUP_POINTS",
      "REFERRAL_PURCHASE_POINTS",
      "signup_rewarded",
      "purchase_rewarded",
      "friend_signup",
      "friend_first_purchase",
    ];
    fc.assert(
      fc.property(fc.string(), fc.string(), rewardAmount, (key, state, points) => {
        const rendered = copy.referralStage({ key, state, currentRewardPoints: points, creditedPoints: points });
        const all = `${rendered.name} ${rendered.qualification} ${rendered.state}`;
        for (const token of forbidden) expect(all).not.toContain(token);
      }),
      { numRuns: 300 },
    );
  });

  it("the referral-owned assets contain neither configured figure (Requirement 10.12)", () => {
    // The scoped, deterministic half of the gate. This is the assertion that catches
    // a figure typed into an asset — including into a comment, which ships.
    for (const source of referralOwnedSources()) {
      for (const figure of [CONFIGURED_SIGNUP_POINTS, CONFIGURED_PURCHASE_POINTS]) {
        expect(source.text, `${source.name} contains the configured figure ${String(figure)}`).not.toContain(
          String(figure),
        );
      }
      for (const token of ["earn_referral", "signup_rewarded", "purchase_rewarded"]) {
        expect(source.text, `${source.name} contains ${token}`).not.toContain(token);
      }
    }
  });

  /* ======================================================================== *
   * TASK 29.5 — completing the referral literal gate
   * ======================================================================== */

  /**
   * All FIVE identifiers 29.5 names, over the referral-owned sources.
   *
   * The property test above already proves none of the five can be RENDERED. This
   * asserts none of them is PRESENT — a different claim, and the one that catches a
   * constant name typed into a comment or a dead branch, both of which ship.
   *
   * Three of the five were already covered here; `REFERRAL_SIGNUP_POINTS` and
   * `REFERRAL_PURCHASE_POINTS` were checked only against rendered copy, which a
   * source-level occurrence would pass.
   */
  const FORBIDDEN_IDENTIFIERS: readonly string[] = [
    "earn_referral",
    "REFERRAL_SIGNUP_POINTS",
    "REFERRAL_PURCHASE_POINTS",
    "signup_rewarded",
    "purchase_rewarded",
  ];

  it("task 29.5 — no referral-owned source contains ANY of the five identifiers", () => {
    const offenders: string[] = [];
    for (const source of referralOwnedSources()) {
      for (const token of FORBIDDEN_IDENTIFIERS) {
        if (source.text.includes(token)) offenders.push(`${source.name}: ${token}`);
      }
    }
    expect(offenders, `internal referral identifiers in shipped sources:\n  ${offenders.join("\n  ")}`).toEqual(
      [],
    );
  });

  /**
   * The layout allowlist for numeric literals.
   *
   * 29.5 forbids "a numeric reward literal outside an allowlist of layout values". A
   * blanket ban on digits is impossible — a stylesheet is nothing but numbers, and a
   * bundle is full of array indices — so the rule is applied to numbers in POSITIONS
   * where a reward figure could plausibly be written, with genuine layout numbers
   * excluded by context.
   *
   * The allowlist is the design system's own scale (§18.3's spacing steps, the radii,
   * the breakpoints, the 44 px target) plus the small integers any code uses. A
   * reward figure is a two-or-three-digit points value or a pounds amount, and none
   * of those is in the scale.
   */
  /**
   * ── THE ALLOWLIST IS ONE VALUE, AND THAT IS DELIBERATE ─────────────────────
   * The first draft of this listed forty numbers: §18.3's spacing scale, the radii,
   * the breakpoints, the type scale. Every one of them turned out to be unnecessary,
   * because each appears in the sources with a UNIT — `24px`, `750px`, `6px` — and the
   * scan's `(?![\w%.]|px|em|…)` guard already excludes a number carrying a unit.
   *
   * Allowlisting them anyway would have been actively harmful: it would have permitted
   * a literal `1000 points` or `300 points`, since `1000` and `300` were on the list as
   * a container width and an image dimension. A gate is only as strong as its narrowest
   * allowlist, and this one is now a single entry with everything else excluded by the
   * position it occupies rather than by its value.
   */
  const LAYOUT_ALLOWLIST: ReadonlySet<number> = new Set([
    // Zero. Initialisation and comparison — `let capturedAt = 0`, `capturedAt > 0`.
    // Not a reward figure in any framing: nobody advertises earning zero points.
    0,
  ]);

  it("task 29.5 — no numeric reward literal appears outside the layout allowlist", () => {
    const offenders: string[] = [];
    for (const source of referralOwnedSources()) {
      // The compiled bundle is minified and full of machine-generated integers; the
      // configured figures are already asserted absent from it above, and scanning
      // arbitrary minified integers produces noise rather than findings.
      if (source.name.endsWith(".js")) continue;

      const text = source.text
        // Comments discuss the figures they forbid, which is documentation.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
        .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
        // ── Two CONTEXT exclusions, not value exclusions ──────────────────────
        // Both were found by running this gate, and neither is a reward figure. They
        // are excluded by the position the number occupies rather than by its value,
        // so the same digits still fail anywhere a reward could be written. Adding
        // 30, 60, 400 and 1000 to the allowlist instead would have let a literal
        // `1000 points` through, which is the opposite of the intent.
        //
        // 1. A named duration: `const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000`. The
        //    numbers are time units composing the 30-day referral-capture expiry.
        .replace(/const\s+\w*(?:_MS|_SECONDS|_MINUTES|_HOURS|_DAYS|Ms|Seconds|Minutes|Hours|Days)\s*=\s*[^;]+;/g, "")
        // 2. A CSS font weight. `400` is a weight keyword's numeric form, and the
        //    `(?!px)` guard cannot exclude it because a weight carries no unit.
        .replace(/font-weight:\s*\d+/g, "")
        // 3. A named bound: `const CODE_MAX = 64` is the referral code's maximum
        //    length, a validation limit rather than an economic figure. Excluded by
        //    the name so that raising it to 128 is not a spurious failure — and so
        //    that the value 64 is not blanket-permitted elsewhere.
        .replace(/const\s+\w*(?:_MAX|_MIN|_LIMIT|_LENGTH)\s*=\s*\d+\s*;/g, "")
        // 4. An HTML bound or geometry attribute: `maxlength="64"`, `width="80"`. The
        //    same class of value as (3), expressed in markup rather than TypeScript.
        .replace(/\b(?:maxlength|minlength|width|height|size|rows|cols|tabindex|colspan|rowspan)="\d+"/g, "");

      for (const match of text.matchAll(/(?<![\w.#-])(\d{1,5})(?![\w%.]|px|em|rem|ch|vh|vw)/g)) {
        const value = Number(match[1]);
        if (LAYOUT_ALLOWLIST.has(value)) continue;
        offenders.push(`${source.name}: bare numeric literal ${String(value)}`);
      }
    }
    expect(offenders, `numeric literals outside the layout allowlist:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("task 29.5 is NON-VACUOUS: the literal scan finds a reward figure when present", () => {
    // Proves the scan would catch the defect it exists to catch — the `150` a
    // developer might type when the API is slow to return, which is exactly the
    // regression Requirement 10.12 was written against.
    const scan = (text: string): number[] =>
      [...text.matchAll(/(?<![\w.#-])(\d{1,5})(?![\w%.]|px|em|rem|ch|vh|vw)/g)]
        .map((m) => Number(m[1]))
        .filter((value) => !LAYOUT_ALLOWLIST.has(value));

    // The two configured figures, in the shapes they would realistically appear.
    expect(scan("const fallback = 150;")).toContain(150);
    expect(scan("You earn 250 points")).toContain(250);
    expect(scan("<span>150 points</span>")).toContain(150);
    // Genuine layout values must NOT be flagged, or the gate is unusable.
    expect(scan("padding: 24px 16px;")).toEqual([]);
    expect(scan("min-height: 44px;")).toEqual([]);
    expect(scan("@media screen and (min-width: 750px)")).toEqual([]);
    expect(scan("border-radius: 6px;")).toEqual([]);
    // And the real sources really are clean, so the assertion above is meaningful
    // rather than passing because the scan matches nothing at all.
    expect(LAYOUT_ALLOWLIST.has(150)).toBe(false);
    expect(LAYOUT_ALLOWLIST.has(250)).toBe(false);

    // ── The two context exclusions must be narrow ──────────────────────────────
    // Each removes a specific declaration shape, NOT a value. So the same digits
    // still fail when they appear where a reward figure would.
    const strip = (text: string): string =>
      text
        .replace(/const\s+\w*(?:_MS|_SECONDS|_MINUTES|_HOURS|_DAYS|Ms|Seconds|Minutes|Hours|Days)\s*=\s*[^;]+;/g, "")
        .replace(/font-weight:\s*\d+/g, "")
        .replace(/const\s+\w*(?:_MAX|_MIN|_LIMIT|_LENGTH)\s*=\s*\d+\s*;/g, "")
        .replace(/\b(?:maxlength|minlength|width|height|size|rows|cols|tabindex|colspan|rowspan)="\d+"/g, "");

    // Excluded: the named duration and the font weight.
    expect(scan(strip("const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;"))).toEqual([]);
    expect(scan(strip("font-weight: 400;"))).toEqual([]);
    // NOT excluded: the same numbers in a reward position.
    expect(scan(strip("const bonus = 1000;"))).toContain(1000);
    // A container width WITH its unit is excluded by the unit guard, not by a value
    // allowlist — which is why the allowlist could shrink to one entry.
    expect(scan(strip("--athoor-container: 1000px;"))).toEqual([]);
    expect(scan(strip("padding: 24px 16px; border-radius: 6px;"))).toEqual([]);
    // A named bound is excluded; the same value in a reward position is not.
    expect(scan(strip("const CODE_MAX = 64;"))).toEqual([]);
    expect(scan(strip("You earn 64 points"))).toContain(64);
    expect(scan(strip("You earn 400 points"))).toContain(400);
    expect(scan(strip("const REWARD_POINTS = 30 * 5;"))).toContain(30);
    // And a duration-named constant cannot smuggle a reward through by being renamed
    // — the exclusion requires the suffix, so `const REWARD_MS` would be a deliberate
    // and visible lie rather than an accident.
    expect(scan(strip("const points = 150; const T_MS = 60 * 1000;"))).toEqual([150]);
  });

  it("the built referral bundle carries no points table of its own", () => {
    const bundle = readFileSync(join(THEME_ASSETS, "athoor-portal-referrals.js"), "utf8");
    // The wording lives in the shared copy map inside core, and the figures come
    // from the response. Neither belongs in this bundle.
    expect(bundle).not.toContain("When your friend joins");
    // And there is no fetch boundary here either: core owns the only one.
    expect(bundle).not.toContain("fetch(");
  });
});

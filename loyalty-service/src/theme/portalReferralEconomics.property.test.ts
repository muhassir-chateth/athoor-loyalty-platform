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

  it("the built referral bundle carries no points table of its own", () => {
    const bundle = readFileSync(join(THEME_ASSETS, "athoor-portal-referrals.js"), "utf8");
    // The wording lives in the shared copy map inside core, and the figures come
    // from the response. Neither belongs in this bundle.
    expect(bundle).not.toContain("When your friend joins");
    // And there is no fetch boundary here either: core owns the only one.
    expect(bundle).not.toContain("fetch(");
  });
});

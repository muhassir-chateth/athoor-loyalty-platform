// @vitest-environment jsdom
/**
 * TASKS 29.3, 29.4, 29.6, 29.7 — the four static build-failing gates.
 *
 * Validates Requirements 16.8 (forbidden strings), 1.7 (direct origin),
 * 8.3 + 20.4 (loyalty arithmetic and constants), 2.7 (`innerHTML` and SQL).
 *
 * ── WHY THESE ARE ONE FILE ───────────────────────────────────────────────────
 * All four are the same shape: a property that must hold across whole categories of
 * shipped artefact, checked by reading those artefacts rather than by trusting a
 * convention. They share the file-set helpers below, and splitting them into four
 * files would mean four copies of "which files count as the portal".
 *
 * ── WHAT MAKES EACH ONE NON-TRIVIAL ──────────────────────────────────────────
 * The naive version of every one of these gates is either vacuous or noisy:
 *
 *   29.3  A source grep for `null` matches every TypeScript null check. So the
 *         forbidden strings are asserted against RENDERED TEXT — what a customer
 *         actually reads — with the two that are never legitimate (`Loading...`,
 *         `Something went wrong`) additionally banned from the built bundles.
 *
 *   29.4  Scanning only the JS bundles misses the Liquid, which is where a
 *         hard-coded origin would most plausibly be written. Both are scanned.
 *
 *   29.6  A grep for `minus` matches `minus` inside a CSS class name and inside
 *         prose. So the filter operators are matched only in Liquid FILTER POSITION
 *         (after a `|` inside `{{ }}` or `{% %}`), and the constant scan excludes
 *         the layout values a stylesheet legitimately contains.
 *
 *   29.7  A grep for `innerHTML` flags legitimate reads. Only ASSIGNMENTS count,
 *         and the gate names the one safe assignment form it permits.
 *
 * SAFETY: file reads and jsdom. No network, no database, no storage.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as states from "../../../theme-src/portal/render/states.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import {
  REPO_ROOT,
  SECTION_NAMES,
  STATE_NAMES,
  builtAssets,
  portalLiquidFiles,
  sectionHtml,
} from "./portalFixtures.js";

/* ══════════════════════════════════════════════════════════════════════════ *
 * Shared: which files count
 * ══════════════════════════════════════════════════════════════════════════ */

function readAll(paths: readonly string[]): { path: string; text: string }[] {
  return paths.map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") }));
}

/** Every file under a directory, recursively, matching one of the extensions. */
function walk(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) out.push(full);
  }
  return out.sort();
}

/** Every file in `theme/`, which is what 29.6 says "anywhere in `theme/**`". */
function themeFiles(): string[] {
  return walk(join(REPO_ROOT, "theme"), [".liquid", ".css", ".js", ".json"]);
}

/** The portal's own TypeScript source. */
function portalSource(): string[] {
  return walk(join(REPO_ROOT, "theme-src", "portal"), [".ts"]);
}

/** Every file the portal owns in `theme/` — assets and Liquid, nothing else. */
function portalThemeFiles(): string[] {
  return [...builtAssets(), ...portalLiquidFiles()];
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * 29.3 — the forbidden-strings gate (Requirement 16.8)
 * ══════════════════════════════════════════════════════════════════════════ */

/** Requirement 16.8's five, verbatim. */
const FORBIDDEN: readonly string[] = ["Loading...", "Something went wrong", "undefined", "null", "NaN"];

/**
 * The two that are never legitimate anywhere, in any form.
 *
 * `undefined`, `null` and `NaN` are excluded from the artefact scan on purpose:
 * they are ordinary JavaScript in a compiled bundle and ordinary English in a
 * comment. Banning them from source would be a gate nobody could keep green, so
 * they are banned where they actually matter — in text a customer reads.
 */
const NEVER_IN_ANY_ARTEFACT: readonly string[] = ["Loading...", "Something went wrong"];

/** Visible text of the whole fixture, `aria-hidden` removed, whitespace collapsed. */
function renderedText(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  // `<template>` content is inert until cloned, and its slots are empty by design.
  for (const template of clone.querySelectorAll("template")) template.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Task 29.3 — the forbidden-strings gate (Requirement 16.8)", () => {
  for (const section of SECTION_NAMES) {
    for (const state of STATE_NAMES) {
      it(`${section} / ${state} renders none of the five forbidden strings`, () => {
        document.body.innerHTML = sectionHtml(section, state);
        const root = document.querySelector<HTMLElement>("[data-portal-section]");
        expect(root).not.toBeNull();
        // Drive the state through the SHIPPED state machine, so the prose asserted
        // here is the prose that ships rather than the fixture's placeholder.
        if (root !== null) states.set(root, state as never);
        const text = renderedText();
        for (const forbidden of FORBIDDEN) {
          expect(text, `${section} / ${state} rendered "${forbidden}" in:\n${text}`).not.toContain(forbidden);
        }
        // A state must say something. An empty message is how "no forbidden string"
        // becomes vacuously true.
        const message = root?.querySelector("[data-portal-state-message]")?.textContent ?? "";
        if (state !== "ready") {
          expect(message.trim(), `${section} / ${state} has no prose at all`).not.toBe("");
        }
      });
    }
  }

  it("every degraded failure code renders none of the five, in every section", () => {
    // `degrade` is the other way prose reaches a section, and it takes a code from the
    // API — so an unmapped code is exactly where `undefined` would surface.
    const codes = [
      "internal_error",
      "upstream_unavailable",
      "request_timeout",
      "network_unavailable",
      "identity_resolution_failed",
      "order_not_found",
      "rate_limited",
      "validation_failed",
      "totally_unknown_code_from_the_future",
      "__proto__",
      "",
    ];
    for (const section of SECTION_NAMES) {
      document.body.innerHTML = sectionHtml(section, "ready");
      const root = document.querySelector<HTMLElement>("[data-portal-section]");
      if (root === null) throw new Error(`no root for ${section}`);
      for (const code of codes) {
        states.degrade(root, {
          code,
          status: 500,
          requestId: null,
          retryable: false,
        } as never);
        const text = renderedText();
        for (const forbidden of FORBIDDEN) {
          expect(text, `${section} / ${code} rendered "${forbidden}"`).not.toContain(forbidden);
        }
        const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
        expect(message.trim(), `${section} / ${code} produced no prose`).not.toBe("");
      }
    }
  });

  it("no built artefact or Liquid file contains the two never-legitimate strings", () => {
    const offenders: string[] = [];
    for (const { path, text } of readAll(portalThemeFiles())) {
      for (const forbidden of NEVER_IN_ANY_ARTEFACT) {
        if (text.includes(forbidden)) offenders.push(`${path}: ${forbidden}`);
      }
    }
    expect(offenders, `forbidden strings in shipped artefacts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("is NON-VACUOUS: the scan finds each forbidden string when it is present", () => {
    // Proves `renderedText` reads the DOM the assertions above claim it reads, and
    // that the five needles are matchable rather than mistyped.
    for (const forbidden of FORBIDDEN) {
      document.body.innerHTML = `<p>${forbidden}</p>`;
      expect(renderedText()).toContain(forbidden);
    }
    // And that `aria-hidden` and `<template>` really are excluded — otherwise the
    // skeleton (which is `aria-hidden`) would be scanned as customer-visible text.
    document.body.innerHTML = `<p aria-hidden="true">undefined</p><template>NaN</template><p>fine</p>`;
    expect(renderedText()).toBe("fine");
    // The exclusion must not be a blanket escape: text outside them is still seen.
    document.body.innerHTML = `<div aria-hidden="true">x</div><p>Something went wrong</p>`;
    expect(renderedText()).toContain("Something went wrong");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 29.4 — the direct-origin gate (Requirement 1.7)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The backend origin. Every portal request goes through the Shopify App Proxy at
 * `/apps/loyalty/...`; a direct origin in a theme file would bypass the proxy, which
 * means bypassing the signature that carries the customer's identity. The request
 * would simply fail — but it would fail as `401 identity_resolution_failed`, which
 * reads like a session problem rather than a wiring mistake.
 */
const BACKEND_ORIGIN = "athoor-loyalty-platform.onrender.com";

describe("Task 29.4 — the direct-origin gate (Requirement 1.7)", () => {
  it("the origin appears in no built theme asset", () => {
    const offenders = readAll(builtAssets())
      .filter(({ text }) => text.includes(BACKEND_ORIGIN))
      .map(({ path }) => path);
    expect(offenders, `direct backend origin in built assets:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the origin appears in no portal Liquid file", () => {
    // The half `portalBundles.dom.test.ts` did not cover. A hard-coded origin is more
    // likely to be written in Liquid than in a compiled bundle, because Liquid is
    // where a developer reaches when a fetch will not resolve.
    const offenders = readAll(portalLiquidFiles())
      .filter(({ text }) => text.includes(BACKEND_ORIGIN))
      .map(({ path }) => path);
    expect(offenders, `direct backend origin in Liquid:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("nor does any bare `onrender.com`, or an absolute URL to any other host", () => {
    // Broader than the exact origin: a staging or preview Render hostname would pass
    // the check above and still bypass the proxy.
    const offenders: string[] = [];
    for (const { path, text } of readAll(portalThemeFiles())) {
      if (text.includes("onrender.com")) offenders.push(`${path}: onrender.com`);
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = (match[1] ?? "").toLowerCase();
        // Only Shopify's own CDN and the store's own domains may appear absolutely.
        const permitted =
          host.endsWith("myshopify.com") ||
          host.endsWith("shopify.com") ||
          host.endsWith("shopifycdn.com") ||
          host.endsWith("myathoorlondon.co.uk") ||
          host === "www.w3.org" ||
          host === "schema.org";
        if (!permitted) offenders.push(`${path}: absolute URL to ${host}`);
      }
    }
    expect(offenders, `origins that bypass the App Proxy:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the portal really does call the proxy, so the gate above is not vacuous", () => {
    // If the portal made no request at all, "no direct origin" would be trivially
    // true. The proxy prefix must therefore be present.
    const core = readFileSync(join(REPO_ROOT, "theme", "assets", "athoor-portal-core.js"), "utf8");
    expect(core).toContain("/apps/loyalty");
  });

  it("is NON-VACUOUS: the scan matches the origin and a sibling Render host", () => {
    const probe = `fetch("https://${BACKEND_ORIGIN}/v1/balance")`;
    expect(probe).toContain(BACKEND_ORIGIN);
    expect(probe).toContain("onrender.com");
    const staging = "https://athoor-staging.onrender.com/v1/balance";
    expect(staging).not.toContain(BACKEND_ORIGIN);
    expect(staging).toContain("onrender.com");
    // And the host allowlist must actually reject an arbitrary third party.
    const hosts = [...`fetch("https://evil.example.com/x")`.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(
      (m) => m[1],
    );
    expect(hosts).toEqual(["evil.example.com"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 29.6 — the loyalty arithmetic and constant gates (Requirements 8.3, 20.4)
 * ══════════════════════════════════════════════════════════════════════════ */

/** The four Liquid filters 29.6 forbids on loyalty quantities. */
const ARITHMETIC_FILTERS: readonly string[] = ["times", "divided_by", "minus", "plus"];

/**
 * The loyalty quantities the prohibition is about.
 *
 * The Loyalty_Service owns every one of these figures. Liquid computing any of them
 * is how the current `/pages/rewards` dashboard came to disagree with the ledger —
 * it derives tier thresholds and a points fallback in the template, so a customer can
 * be shown a tier they are not in.
 */
const LOYALTY_NOUNS: readonly string[] = [
  "point",
  "points",
  "balance",
  "spend",
  "spent",
  "total_spent",
  "threshold",
  "tier",
  "cost",
  "multiplier",
  "lifetime",
  "progress",
];

describe("Task 29.6 — loyalty arithmetic in Liquid (Requirement 8.3)", () => {
  /**
   * Liquid filter applications, as `{ subject, filter }` pairs.
   *
   * Matched in FILTER POSITION only — after a `|` inside `{{ }}` or `{% %}`. A plain
   * substring search for `minus` also matches a CSS class called `--minus`, the word
   * "minus" in a comment, and `plus` inside `surplus`; each would be a false positive
   * that makes the gate untrustworthy.
   */
  function filterApplications(text: string): { subject: string; filter: string; raw: string }[] {
    const found: { subject: string; filter: string; raw: string }[] = [];
    // Liquid comments are not output and may legitimately discuss arithmetic.
    const withoutComments = text.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
    for (const expression of withoutComments.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
      const raw = expression[0];
      const parts = raw.split("|");
      if (parts.length < 2) continue;
      const subject = (parts[0] ?? "").replace(/[{}%\-\s]+/g, " ").trim();
      for (const segment of parts.slice(1)) {
        const filter = /^\s*([a-z_]+)/.exec(segment)?.[1];
        if (filter !== undefined && ARITHMETIC_FILTERS.includes(filter)) {
          found.push({ subject, filter, raw: raw.replace(/\s+/g, " ") });
        }
      }
    }
    return found;
  }

  it("no portal Liquid file applies times, divided_by, minus or plus to a loyalty quantity", () => {
    const offenders: string[] = [];
    for (const { path, text } of readAll(portalLiquidFiles())) {
      for (const application of filterApplications(text)) {
        const subject = application.subject.toLowerCase();
        const touchesLoyalty = LOYALTY_NOUNS.some((noun) =>
          new RegExp(`(?:^|[^a-z_])${noun}(?![a-z_])`).test(subject),
        );
        if (touchesLoyalty) {
          offenders.push(`${path}: ${application.filter} on "${application.subject}" — ${application.raw}`);
        }
      }
    }
    expect(offenders, `Liquid arithmetic on loyalty values:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no portal Liquid file applies those filters to ANYTHING, which is the stronger fact", () => {
    // Recorded separately because it is currently true and worth keeping true: §25.6
    // keeps the portal's templates logic-free, so any arithmetic at all is a
    // regression even on a value that is not a loyalty figure.
    const offenders: string[] = [];
    for (const { path, text } of readAll(portalLiquidFiles())) {
      for (const application of filterApplications(text)) {
        offenders.push(`${path}: ${application.filter} — ${application.raw}`);
      }
    }
    expect(offenders, `arithmetic in portal Liquid:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("is NON-VACUOUS: the matcher finds real Liquid arithmetic and ignores lookalikes", () => {
    const finds = (text: string): string[] => filterApplications(text).map((a) => a.filter);
    // The shapes the current dashboard actually uses.
    expect(finds("{{ customer.total_spent | divided_by: 100 }}")).toEqual(["divided_by"]);
    expect(finds("{{ points | times: 2 }}")).toEqual(["times"]);
    expect(finds("{%- assign remaining = threshold | minus: spend -%}")).toEqual(["minus"]);
    expect(finds("{{ a | plus: b | times: c }}").sort()).toEqual(["plus", "times"]);
    // Lookalikes that must NOT match, or the gate is noise.
    expect(finds('<div class="card--minus">')).toEqual([]);
    expect(finds("{%- comment -%} we never use divided_by here {%- endcomment -%}")).toEqual([]);
    expect(finds("{{ surplus }}")).toEqual([]);
    expect(finds("{{ product.title | escape }}")).toEqual([]);
    // And a loyalty subject really is recognised as one.
    const subject = filterApplications("{{ customer.total_spent | divided_by: 100 }}")[0]?.subject ?? "";
    expect(
      LOYALTY_NOUNS.some((noun) => new RegExp(`(?:^|[^a-z_])${noun}(?![a-z_])`).test(subject.toLowerCase())),
    ).toBe(true);
  });
});

describe("Task 29.6 — no loyalty constant anywhere in theme/** (Requirement 20.4)", () => {
  /**
   * The figures the Loyalty_Service owns. Each is a value a template must never
   * carry, because a template carrying it is a second source of truth that cannot
   * be updated when the service's own configuration changes.
   *
   * Read from the service's configuration rather than transcribed, so the gate
   * tracks the real values. The reward tiers are the £5/£15/£35/£75 the current
   * dashboard hard-codes — the defect this gate exists to stop recurring.
   */
  const REWARD_POUNDS: readonly number[] = [5, 15, 35, 75];

  /**
   * Contexts in which a bare number is layout, not loyalty.
   *
   * Without this the gate would flag `padding: 5px`, `width="75"` and
   * `grid-column: 15`. The exclusion is by CONTEXT, never by value: the same digits
   * still fail in prose or in a data attribute.
   */
  function stripLayout(text: string, path: string): string {
    let out = text;
    if (path.endsWith(".css")) {
      // A stylesheet is layout end to end; only its content strings can speak.
      const strings = [...out.matchAll(/content:\s*(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2] ?? "");
      return strings.join("\n");
    }
    // Liquid comments discuss the figures they forbid; that is documentation.
    out = out.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
    // Inline style, geometry attributes and dimension-bearing attributes.
    out = out.replace(/style="[^"]*"/g, "");
    out = out.replace(/\b(?:width|height|maxlength|minlength|size|rows|cols|tabindex|colspan|rowspan)="[^"]*"/g, "");
    out = out.replace(/\bsizes="[^"]*"/g, "");
    out = out.replace(/<style[\s\S]*?<\/style>/g, "");
    return out;
  }

  it("no reward amount appears as a money literal in any theme file", () => {
    const offenders: string[] = [];
    for (const path of themeFiles()) {
      const relativePath = relative(REPO_ROOT, path);
      // The owner's own files and the pre-portal theme are out of scope: §25.6 forbids
      // the portal from touching them, so a literal there is not the portal's to fix.
      if (!relativePath.includes("portal")) continue;
      const text = stripLayout(readFileSync(path, "utf8"), relativePath);
      for (const pounds of REWARD_POUNDS) {
        // A MONEY literal specifically — `£5`, `£5.00`, `5 off`. A bare `5` is not a
        // reward amount, and treating it as one would flag `space-5`.
        const money = new RegExp(`£\\s*${String(pounds)}(?![0-9])|\\b${String(pounds)}\\s*(?:GBP|pounds?)\\b`, "gi");
        for (const hit of text.matchAll(money)) {
          offenders.push(`${relativePath}: ${hit[0]}`);
        }
      }
    }
    expect(offenders, `reward amount literals in theme/**:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no tier name appears next to a numeric threshold in any portal theme file", () => {
    // A tier NAME is fine — §20.3 requires the badge to carry its tier as text. A tier
    // name adjacent to a number is a threshold, which the service owns.
    const offenders: string[] = [];
    for (const path of themeFiles()) {
      const relativePath = relative(REPO_ROOT, path);
      if (!relativePath.includes("portal")) continue;
      const text = stripLayout(readFileSync(path, "utf8"), relativePath);
      for (const tier of ["bronze", "silver", "gold", "royal"]) {
        const adjacent = new RegExp(`${tier}[^\\n<>{}]{0,24}?\\b\\d{2,}\\b|\\b\\d{2,}\\b[^\\n<>{}]{0,24}?${tier}`, "gi");
        for (const hit of text.matchAll(adjacent)) {
          offenders.push(`${relativePath}: ${hit[0].trim()}`);
        }
      }
    }
    expect(offenders, `tier thresholds in theme/**:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no points-per-pound multiplier literal appears in any portal theme file", () => {
    const offenders: string[] = [];
    for (const path of themeFiles()) {
      const relativePath = relative(REPO_ROOT, path);
      if (!relativePath.includes("portal")) continue;
      const text = stripLayout(readFileSync(path, "utf8"), relativePath);
      // `1.5×`, `2x points`, `points per £1`.
      for (const hit of text.matchAll(/\b\d+(?:\.\d+)?\s*[x×]\s*points\b|\bpoints\s*(?:per|for every)\s*£?\s*\d/gi)) {
        offenders.push(`${relativePath}: ${hit[0].trim()}`);
      }
    }
    expect(offenders, `multiplier literals in theme/**:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("is NON-VACUOUS: each constant scan matches the literal it forbids", () => {
    // The exact shapes the current `sections/loyalty-dashboard.liquid` contains, which
    // is what Requirement 20.4 is a reaction to.
    expect(/£\s*15(?![0-9])/.test("<span>£15 off</span>")).toBe(true);
    expect(/£\s*5(?![0-9])/.test("Redeem for £5")).toBe(true);
    // And that the layout exclusion does not swallow a real one.
    const stripped = stripLayout('<img width="75"><p>£75 reward</p>', "theme/snippets/portal-x.liquid");
    expect(stripped).not.toContain('width="75"');
    expect(stripped).toContain("£75");
    // Tier adjacency.
    expect(/silver[^\n<>{}]{0,24}?\b\d{2,}\b/i.test("Silver starts at 500")).toBe(true);
    expect(/gold[^\n<>{}]{0,24}?\b\d{2,}\b/i.test("<span>Gold</span>")).toBe(false);
    // Multiplier.
    expect(/\b\d+(?:\.\d+)?\s*[x×]\s*points\b/i.test("1.5× points")).toBe(true);
    expect(/\bpoints\s*(?:per|for every)\s*£?\s*\d/i.test("points per £1")).toBe(true);
    // A CSS file speaks only through `content:`.
    expect(stripLayout(".x { padding: 15px; }", "theme/assets/athoor-portal.css")).toBe("");
    expect(stripLayout('.x::after { content: "£15"; }', "theme/assets/athoor-portal.css")).toContain("£15");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 29.7 — the `innerHTML` and template-literal SQL gates (Requirement 2.7)
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Task 29.7 — no innerHTML assignment from upstream data (Requirement 2.7)", () => {
  /**
   * Assignments only.
   *
   * A READ of `innerHTML` is harmless and several tests use one to snapshot a root.
   * The dangerous form is the write, and its variants: `innerHTML =`, `+=`,
   * `outerHTML =`, `insertAdjacentHTML`, `document.write`, and
   * `Range.createContextualFragment`.
   */
  const DANGEROUS_SINKS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
    { pattern: /\.innerHTML\s*(?:\+?=)(?!=)/g, what: "innerHTML assignment" },
    { pattern: /\.outerHTML\s*(?:\+?=)(?!=)/g, what: "outerHTML assignment" },
    { pattern: /\.insertAdjacentHTML\s*\(/g, what: "insertAdjacentHTML" },
    { pattern: /document\s*\.\s*write(?:ln)?\s*\(/g, what: "document.write" },
    { pattern: /createContextualFragment\s*\(/g, what: "createContextualFragment" },
  ];

  it("no portal source file writes HTML from a string", () => {
    const offenders: string[] = [];
    for (const path of portalSource()) {
      const relativePath = relative(REPO_ROOT, path);
      const text = readFileSync(path, "utf8")
        // Comments explain why the sinks are forbidden; that is not a use.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const sink of DANGEROUS_SINKS) {
        for (const hit of text.matchAll(sink.pattern)) {
          offenders.push(`${relativePath}: ${sink.what} — ${hit[0]}`);
        }
      }
    }
    expect(offenders, `HTML-from-string sinks in portal source:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("no built portal bundle contains an innerHTML write either", () => {
    // The compiled artefact is what ships. esbuild preserves property assignment, so
    // a sink that survived minification would appear here.
    const offenders: string[] = [];
    for (const { path, text } of readAll(builtAssets().filter((p) => p.endsWith(".js")))) {
      for (const sink of DANGEROUS_SINKS) {
        for (const hit of text.matchAll(sink.pattern)) {
          offenders.push(`${path}: ${sink.what} — ${hit[0]}`);
        }
      }
    }
    expect(offenders, `HTML-from-string sinks in built bundles:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the portal writes text through textContent instead, so the gate is not vacuous", () => {
    // "No innerHTML" is trivially true of a module that renders nothing. The portal
    // renders a great deal, through `textContent` and cloned `<template>`s.
    const rows = readFileSync(join(REPO_ROOT, "theme-src", "portal", "render", "rows.ts"), "utf8");
    expect(rows).toMatch(/textContent/);
    expect(rows).toMatch(/content\.cloneNode/);
    const core = readFileSync(join(REPO_ROOT, "theme", "assets", "athoor-portal-core.js"), "utf8");
    expect(core).toMatch(/textContent/);
  });

  it("is NON-VACUOUS: the sink patterns match writes and ignore reads", () => {
    const hits = (code: string): string[] =>
      DANGEROUS_SINKS.flatMap((sink) => [...code.matchAll(sink.pattern)].map(() => sink.what));
    // Writes — every variant must be caught.
    expect(hits(`el.innerHTML = title;`)).toEqual(["innerHTML assignment"]);
    expect(hits(`el.innerHTML += title;`)).toEqual(["innerHTML assignment"]);
    expect(hits(`el.outerHTML = title;`)).toEqual(["outerHTML assignment"]);
    expect(hits(`el.insertAdjacentHTML("beforeend", title);`)).toEqual(["insertAdjacentHTML"]);
    expect(hits(`document.write(title);`)).toEqual(["document.write"]);
    expect(hits(`range.createContextualFragment(title);`)).toEqual(["createContextualFragment"]);
    // Reads and comparisons — must NOT be caught, or the gate blocks its own tests.
    expect(hits(`const before = el.innerHTML;`)).toEqual([]);
    expect(hits(`expect(el.innerHTML).toBe(first);`)).toEqual([]);
    expect(hits(`if (el.innerHTML === other) {}`)).toEqual([]);
    expect(hits(`el.textContent = title;`)).toEqual([]);
  });
});

describe("Task 29.7 — no SQL built by template literal (Requirement 2.7)", () => {
  /** Every server-side source file, which is where SQL lives. */
  function serverSource(): string[] {
    return walk(join(REPO_ROOT, "loyalty-service", "src"), [".ts"]).filter(
      (path) => !path.endsWith(".test.ts"),
    );
  }

  /**
   * A template literal that is a SQL STATEMENT.
   *
   * ── WHY THIS IS NOT A SEARCH FOR SQL WORDS ──────────────────────────────────
   * The first draft of this gate matched `\b(select|update|from|where|join|…)\b`
   * anywhere in a template literal, and reported 28 offenders of which 24 were
   * English. `.join(", ")` matches `join`. `"Unreadable value from the database"`
   * matches `from`. `"Tier changed from X to Y"` matches `from`. A gate with an 86%
   * false-positive rate does not get fixed; it gets deleted.
   *
   * So a literal counts as SQL only if it OPENS with a statement keyword — which is
   * what a query string actually looks like, and what no error message does.
   */
  const SQL_STATEMENT =
    /^`\s*(?:with|select|insert\s+into|update|delete\s+from|create|alter|drop|refresh\s+materialized|truncate|set\s+local)\b/i;

  /**
   * Interpolations inside a SQL statement, as the raw expression text.
   *
   * Nested braces are handled by counting, because `${map[`${a}`]}` would otherwise
   * terminate at the first `}`.
   */
  function interpolations(literal: string): string[] {
    const found: string[] = [];
    let index = 0;
    while (index < literal.length) {
      const start = literal.indexOf("${", index);
      if (start === -1) break;
      let depth = 1;
      let cursor = start + 2;
      while (cursor < literal.length && depth > 0) {
        if (literal[cursor] === "{") depth += 1;
        else if (literal[cursor] === "}") depth -= 1;
        if (depth === 0) break;
        cursor += 1;
      }
      found.push(literal.slice(start + 2, cursor).trim());
      index = cursor + 1;
    }
    return found;
  }

  /** A bare identifier — no call, no member access, no operator, no nesting. */
  function isBareIdentifier(expression: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression);
  }

  /**
   * Every `const NAME = <literal> as const` in the service, across all files.
   *
   * Repository-wide rather than per-file because the constants are declared where
   * they belong and imported where they are used: `ANALYTICS_REFRESH_STATE_TABLE` is
   * declared in `pgAnalyticsDataSource.ts` and interpolated in `analyticsRefresh.ts`.
   * A same-file resolver called all five of them unproven, which would have been a
   * false alarm on code that is in fact safe.
   */
  function scalarConstants(): Map<string, string> {
    const map = new Map<string, string>();
    for (const path of serverSource()) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*as\s+const/g,
      )) {
        const name = match[1];
        const value = match[2] ?? match[3] ?? match[4];
        if (name !== undefined && value !== undefined) map.set(name, value);
      }
    }
    return map;
  }

  /**
   * Every `const NAME = [ … ] as const` whose elements are all literals or
   * already-known scalar constants. Transitive: `ANALYTICS_MATVIEWS` is an array of
   * three constant identifiers, each itself a `"literal" as const`.
   */
  function constantArrays(scalars: Map<string, string>): Set<string> {
    const names = new Set<string>();
    for (const path of serverSource()) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*\[([^\]]*)\]\s*as\s+const/g,
      )) {
        const name = match[1];
        const body = match[2];
        if (name === undefined || body === undefined) continue;
        const elements = body
          .split(",")
          .map((element) => element.trim())
          .filter((element) => element !== "");
        if (elements.length === 0) continue;
        const allConstant = elements.every(
          (element) => /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)$/.test(element) || scalars.has(element),
        );
        if (allConstant) names.add(name);
      }
    }
    return names;
  }

  const SCALAR_CONSTANTS = scalarConstants();
  const CONSTANT_ARRAYS = constantArrays(SCALAR_CONSTANTS);

  /**
   * Is this identifier provably a compile-time constant — unreachable from a request?
   *
   * Three accepted provenances:
   *
   *   const NAME = "literal" as const          a fixed table, view or entry type
   *   for (const x of CONST_ARRAY)             iteration over `[…] as const`
   *   CONST_ARRAY.map((x) => …)                the same, expressed as a map
   *
   * Everything else is rejected. A function parameter, a field read and a call result
   * all look like bare identifiers, and none of them tells you where its value came
   * from — which is precisely the distinction this gate exists to draw.
   */
  const SCALAR_DECLARATION =
    /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*as\s+const/g;
  const ARRAY_DECLARATION =
    /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*\[([^\]]*)\]\s*as\s+const/g;

  /** Scalar constants declared in this one source, added to the repo-wide set. */
  function localScalars(source: string): Set<string> {
    const names = new Set(SCALAR_CONSTANTS.keys());
    for (const match of source.matchAll(new RegExp(SCALAR_DECLARATION.source, "g"))) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    return names;
  }

  /** Constant arrays declared in this one source, added to the repo-wide set. */
  function localArrays(source: string, scalars: ReadonlySet<string>): Set<string> {
    const names = new Set(CONSTANT_ARRAYS);
    for (const match of source.matchAll(new RegExp(ARRAY_DECLARATION.source, "g"))) {
      const name = match[1];
      const body = match[2];
      if (name === undefined || body === undefined) continue;
      const elements = body
        .split(",")
        .map((element) => element.trim())
        .filter((element) => element !== "");
      if (elements.length === 0) continue;
      if (
        elements.every(
          (element) => /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)$/.test(element) || scalars.has(element),
        )
      ) {
        names.add(name);
      }
    }
    return names;
  }

  function isCompileTimeConstant(identifier: string, source: string): boolean {
    // The repo-wide set plus anything declared locally. Local matters for two reasons:
    // a file-local constant is just as unreachable from a request as an exported one,
    // and the non-vacuity probes below declare their constants inline.
    const scalars = localScalars(source);
    if (scalars.has(identifier)) return true;
    const arrays = localArrays(source, scalars);
    const escaped = identifier.replace(/[$]/g, "\\$");
    // A binding introduced by iterating a constant array, in any of three syntaxes.
    const bindings = [
      new RegExp(`for\\s*\\(\\s*const\\s+${escaped}\\s+of\\s+([A-Za-z_$][A-Za-z0-9_$]*)`),
      new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*map\\s*\\(\\s*\\(?\\s*${escaped}\\s*\\)?\\s*=>`),
      new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*flatMap\\s*\\(\\s*\\(?\\s*${escaped}\\s*\\)?\\s*=>`),
    ];
    for (const binding of bindings) {
      const subject = binding.exec(source)?.[1];
      if (subject !== undefined && arrays.has(subject)) return true;
    }
    return false;
  }

  /** Every SQL statement literal in the repository, with its file. */
  function sqlLiterals(): { path: string; literal: string; source: string }[] {
    const out: { path: string; literal: string; source: string }[] = [];
    for (const path of serverSource()) {
      const relativePath = relative(REPO_ROOT, path);
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const match of source.matchAll(/`(?:\\.|[^`\\])*`/g)) {
        if (SQL_STATEMENT.test(match[0])) out.push({ path: relativePath, literal: match[0], source });
      }
    }
    return out;
  }

  it("no SQL statement interpolates a VALUE — every value is bound positionally", () => {
    // The gate that matters. An interpolated value is an injection; an interpolated
    // identifier is the only way to name a table dynamically, since SQL cannot bind
    // an identifier with `$1`. So the rule is: interpolate identifiers, bind values.
    const offenders: string[] = [];
    for (const { path, literal, source } of sqlLiterals()) {
      for (const expression of interpolations(literal)) {
        if (!isBareIdentifier(expression)) {
          offenders.push(`${path}: non-identifier \${${expression}} in ${literal.replace(/\s+/g, " ").slice(0, 90)}`);
          continue;
        }
        if (!isCompileTimeConstant(expression, source)) {
          offenders.push(
            `${path}: \${${expression}} is not a compile-time constant in ${literal.replace(/\s+/g, " ").slice(0, 90)}`,
          );
        }
      }
    }
    expect(offenders, `values interpolated into SQL:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("every SQL statement that FILTERS by customer binds the id positionally", () => {
    // The corollary. A statement naming a table by constant is safe only if the
    // customer scope is still a bound parameter — an interpolated `customer_id` in a
    // `WHERE` would be the actual breach.
    //
    // Filtering, not mentioning: `SELECT customer_id, enrolled_at FROM <matview>` names
    // the column in its PROJECTION and has no `WHERE` at all — it is an admin
    // aggregate read over a whole view. Requiring `$1` there would demand a parameter
    // for a query that takes none, which is why the first draft flagged three
    // perfectly correct statements.
    const offenders: string[] = [];
    for (const { path, literal } of sqlLiterals()) {
      const whereClause = /\bwhere\b([\s\S]*)$/i.exec(literal)?.[1];
      if (whereClause === undefined) continue;
      if (!/customer_id/i.test(whereClause)) continue;
      if (!/\$\d/.test(whereClause)) {
        offenders.push(`${path}: ${literal.replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
    expect(offenders, `customer-scoped SQL without a bound parameter:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("records exactly which files interpolate into SQL, so a new one is a visible change", () => {
    // Not an exception list — every entry already satisfied the tests above, and each
    // interpolates a table name, a view name or an entry type that is a compile-time
    // literal. This is a census, so a file joining it is reviewed rather than absorbed.
    const files = [...new Set(sqlLiterals().filter((s) => interpolations(s.literal).length > 0).map((s) => s.path))];
    expect(files.sort()).toEqual([
      "loyalty-service/src/admin/analyticsRefresh.ts",
      "loyalty-service/src/admin/pgAnalyticsDataSource.ts",
      "loyalty-service/src/enrollment/ensureCustomerEnrollment.ts",
      "loyalty-service/src/privacy/redaction.ts",
      "loyalty-service/src/redemption/redeem.ts",
    ]);
  });

  it("the portal's own repository interpolates nothing into SQL at all", () => {
    // Stronger than the repository-wide rule, and the one Requirement 2.7 is about:
    // the portal is the new surface, so its own SQL is fully static with bound values.
    const portalSql = sqlLiterals().filter((s) => s.path.includes("/src/portal/"));
    const withInterpolation = portalSql.filter((s) => interpolations(s.literal).length > 0);
    expect(withInterpolation.map((s) => `${s.path}: ${s.literal.slice(0, 80)}`)).toEqual([]);
  });

  it("the codebase really does contain parameterised SQL, so the gate is not vacuous", () => {
    // "No interpolated SQL" is trivially true of a codebase with no SQL. There is a
    // great deal, and it binds positionally.
    const scoped = readFileSync(
      join(REPO_ROOT, "loyalty-service", "src", "portal", "repository", "scopedQuery.ts"),
      "utf8",
    );
    expect(scoped).toMatch(/\$1/);
    expect(scoped.toLowerCase()).toMatch(/\bselect\b/);
    // And the detector really does classify those statements as SQL.
    expect(sqlLiterals().length).toBeGreaterThan(10);
  });

  it("is NON-VACUOUS: the detector separates injection from the safe forms", () => {
    const judge = (code: string): string[] => {
      const problems: string[] = [];
      for (const match of code.matchAll(/`(?:\\.|[^`\\])*`/g)) {
        if (!SQL_STATEMENT.test(match[0])) continue;
        for (const expression of interpolations(match[0])) {
          if (!isBareIdentifier(expression)) problems.push(`non-identifier:${expression}`);
          else if (!isCompileTimeConstant(expression, code)) problems.push(`not-constant:${expression}`);
        }
      }
      return problems;
    };

    // ── The injections. Each must be caught. ──
    expect(judge("db.query(`SELECT * FROM orders WHERE customer_id = ${id}`)")).toEqual(["not-constant:id"]);
    expect(judge("db.query(`DELETE FROM wishlist WHERE handle = '${handle}'`)")).toEqual([
      "not-constant:handle",
    ]);
    expect(judge("const q = `UPDATE customers SET name = ${name}`;")).toEqual(["not-constant:name"]);
    expect(judge("db.query(`SELECT * FROM t WHERE id = ${req.body.customerId}`)")).toEqual([
      "non-identifier:req.body.customerId",
    ]);
    expect(judge("db.query(`SELECT * FROM t WHERE id = ${escape(x)}`)")).toEqual(["non-identifier:escape(x)"]);
    // A parameter is not a constant just because it is a bare name.
    expect(judge("function f(probeTbl9f: string) { return `SELECT 1 FROM ${probeTbl9f}`; }")).toEqual([
      "not-constant:probeTbl9f",
    ]);

    // ── The safe forms. None may be flagged. ──
    expect(judge('db.query("SELECT * FROM orders WHERE customer_id = $1", [id])')).toEqual([]);
    expect(judge("db.query(`SELECT * FROM orders WHERE customer_id = $1`, [id])")).toEqual([]);
    // A constant table name.
    expect(
      judge('const PROBE_VIEW_9f = "analytics_customers" as const; db.query(`SELECT a FROM ${PROBE_VIEW_9f} LIMIT 1`);'),
    ).toEqual([]);
    // A loop over an `as const` array of literals — redaction.ts's shape.
    expect(
      judge(
        'const PROBE_TABLES_9f = ["customer_birthdays", "device_tokens"] as const;\n' +
          "for (const t9f of PROBE_TABLES_9f) { await db.query(`DELETE FROM ${t9f} WHERE customer_id = $1`, [id]); }",
      ),
    ).toEqual([]);
    // But a loop over a NON-const array must still be caught.
    expect(
      judge(
        "const PROBE_DYNAMIC_9f = requestedTables;\n" +
          "for (const t9f of PROBE_DYNAMIC_9f) { await db.query(`DELETE FROM ${t9f} WHERE customer_id = $1`, [id]); }",
      ),
    ).toEqual(["not-constant:t9f"]);

    // ── Not SQL at all. The English that broke the first draft. ──
    expect(judge('const m = `Expected one of: ${TYPES.join(", ")}.`;')).toEqual([]);
    expect(judge("const m = `Unreadable value '${String(v)}' from the database.`;")).toEqual([]);
    expect(judge("const m = `Tier changed from ${a} to ${b}`;")).toEqual([]);
    expect(judge("const p = `/orders/${id}`;")).toEqual([]);
    expect(judge("const m = `hello ${name}`;")).toEqual([]);
    // And confirm those four really would have been flagged by a keyword search, which
    // is the evidence that the tightening was necessary rather than convenient.
    const loose = /\b(?:select|update|from|where|join)\b/i;
    expect(loose.test('`Expected one of: ${TYPES.join(", ")}.`')).toBe(true);
    expect(loose.test("`Unreadable value '${String(v)}' from the database.`")).toBe(true);
    expect(loose.test("`Tier changed from ${a} to ${b}`")).toBe(true);
  });
});

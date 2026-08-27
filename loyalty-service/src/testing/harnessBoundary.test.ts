/**
 * The harness is sound, and stays test-only (spec task 16, design §4.6).
 *
 * ── WHY A HARNESS NEEDS ITS OWN TESTS ───────────────────────────────────────
 * Every property in task 16 is asserted THROUGH this harness. If it silently
 * answered 401 to everything, or returned the same data to both customers, those
 * properties would pass while proving nothing — the vacuous-pass failure that
 * `ownership.gate.test.ts` guards against for its scanner. So this file proves the
 * harness can produce real `200`s, that the two customers genuinely differ, and that
 * the route enumeration is not empty.
 *
 * SAFETY: in-memory only. No network, no database, no production.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  A,
  B,
  B_SECRETS,
  bearer,
  bodyFor,
  BODY_METHODS,
  buildHarness,
  concretise,
  idempotencyKey,
  portalRoutes,
  signedUrl,
} from "./portalHarness.js";

describe("the harness is not vacuous — it can produce real 200s", () => {
  it("enumerates a substantial /v1 route surface", async () => {
    const { app, routes } = await buildHarness();
    try {
      // If the enumeration broke, every sweep below would pass over an empty set.
      expect(routes.length).toBeGreaterThanOrEqual(40);
      expect(portalRoutes(routes).length).toBeGreaterThanOrEqual(25);
    } finally {
      await app.close();
    }
  });

  it("authenticates A over the App Proxy and over a bearer token", async () => {
    const { app } = await buildHarness();
    try {
      const proxy = await app.inject({ method: "GET", url: signedUrl("/v1/balance", A.shopifyId) });
      expect(proxy.statusCode).toBe(200);
      const token = await app.inject({ method: "GET", url: "/v1/balance", headers: bearer(A) });
      expect(token.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns DIFFERENT data to A and to B, so isolation is observable", async () => {
    const { app } = await buildHarness();
    try {
      const forA = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: bearer(A) });
      const forB = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: bearer(B) });
      expect(forA.statusCode).toBe(200);
      expect(forB.statusCode).toBe(200);
      // A fake returning the same payload to everyone would make Property 1 pass by
      // construction.
      expect(forA.body).not.toBe(forB.body);
      expect(forA.body).toContain(A.marker);
      expect(forB.body).toContain(B.marker);
    } finally {
      await app.close();
    }
  });

  it("B's markers use a DISJOINT alphabet from A's", () => {
    // Task 15's lesson: two merely-distinct markers can be substrings of one
    // another, and a leak assertion then fails for a reason that is not a leak.
    expect(A.marker).not.toContain(B.marker);
    expect(B.marker).not.toContain(A.marker);
    for (const secret of B_SECRETS) {
      expect(secret).not.toContain(A.marker);
    }
  });

  it("drives a MAJORITY of portal routes to a non-401 outcome for A", async () => {
    const { app, routes } = await buildHarness();
    try {
      const targets = portalRoutes(routes);
      const reached: string[] = [];
      const refused: string[] = [];
      for (const route of targets) {
        const res = await app.inject({
          method: route.method as "GET",
          url: concretise(route.url, A),
          headers: {
            ...bearer(A),
            ...(BODY_METHODS.has(route.method) ? { "idempotency-key": idempotencyKey() } : {}),
          },
          ...(BODY_METHODS.has(route.method) ? { payload: bodyFor(route.url) } : {}),
        });
        (res.statusCode === 401 ? refused : reached).push(
          `${route.method} ${route.url} -> ${res.statusCode}`,
        );
      }
      // The harness authenticates, so nothing should answer 401. A 401 here means the
      // harness — not the service — is misconfigured, and every property asserted
      // through it would be weaker than it looks.
      expect(refused, `authenticated requests were refused:\n${refused.join("\n")}`).toEqual([]);
      expect(reached.length).toBeGreaterThanOrEqual(25);
    } finally {
      await app.close();
    }
  });
});

describe("the harness never reaches production code", () => {
  /** Every non-test `.ts` under `src`, excluding the harness directory itself. */
  function productionSources(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "testing") continue;
        productionSources(full, acc);
      } else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
        acc.push(full);
      }
    }
    return acc;
  }

  it("is imported by NO production module", () => {
    // The fakes in this harness return fabricated customer data. A production module
    // importing it would ship that into a deployed build — so the boundary is a test,
    // not a convention.
    const src = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    for (const file of productionSources(src)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/from\s+"[^"]*testing\/portalHarness/.test(code)) offenders.push(file);
    }
    expect(offenders, `production modules importing the harness:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("holds no real credential or live hostname", () => {
    const code = readFileSync(join(import.meta.dirname, "portalHarness.ts"), "utf8");
    for (const banned of ["shpat_", "shpss_", "postgres://", "postgresql://", "onrender.com"]) {
      expect(code, banned).not.toContain(banned);
    }
  });
});

/**
 * THE REAL-BROWSER PROBE MUST NEVER BECOME A DEPENDENCY.
 *
 * Task 29.10 pins the dependency set and task 33 requires `npm ls --omit=dev` unchanged
 * with NEW RECURRING COST = £0/MONTH. The probe gets a real layout engine from Chrome
 * over CDP using Node's built-in global `WebSocket`. The moment someone "tidies" it by
 * importing `ws`, `puppeteer` or `playwright`, that invariant is gone — and it would look
 * like an improvement in review. So the import list is asserted, not trusted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const PROBE = join(REPO_ROOT, "loyalty-service", "scripts", "theme", "portal-browser-probe.mjs");

describe("real-browser probe stays dependency-free", () => {
  const source = readFileSync(PROBE, "utf8");

  it("imports only node: built-ins", () => {
    const specifiers = [...source.matchAll(/^import\s+[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.length, "expected at least one import to check").toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec, `${spec} is not a node: built-in`).toMatch(/^node:/);
    }
  });

  it("never IMPORTS a browser-automation package", () => {
    // Deliberately scoped to import/require rather than any mention: the file's rationale
    // comment names playwright and puppeteer to explain why they are not used, and that
    // explanation is the reason the constraint survives review.
    const importLike = [
      ...source.matchAll(/(?:^import\s+[^"']*|require\s*\()\s*["']([^"']+)["']/gm),
    ].map((m) => m[1].toLowerCase());
    for (const banned of ["puppeteer", "playwright", "@playwright/test", "ws", "selenium-webdriver"]) {
      expect(importLike, `must not import ${banned}`).not.toContain(banned);
    }
    expect(importLike.length, "expected imports to inspect").toBeGreaterThan(0);
  });

  it("uses a throwaway Chrome profile, never the owner's", () => {
    expect(source).toContain("/tmp/cdp-profile-throwaway");
    expect(source).not.toMatch(/Library\/Application Support\/Google\/Chrome/);
  });

  it("is not listed as a dependency in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "loyalty-service", "package.json"), "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const name of ["puppeteer", "playwright", "@playwright/test", "ws", "selenium-webdriver"]) {
      expect(name in all, `${name} must not be a dependency`).toBe(false);
    }
  });
});

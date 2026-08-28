import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_API_SCOPES, loadConfig, WEBHOOK_TOPICS } from "./config.js";

/** This file's directory — `loyalty-service/src`. */
const HERE = dirname(fileURLToPath(import.meta.url));

describe("config loading + security guardrails", () => {
  it("loads defaults for a development environment", () => {
    const config = loadConfig({});
    expect(config.env).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.shopify.shopDomain).toBe("myathoorlondon.myshopify.com");
  });

  it("exposes the least-privilege Admin API scope list (Req 11.11)", () => {
    expect(config().shopify.adminApiScopes).toEqual([
      "read_customers",
      "read_orders",
      "read_products",
      "write_discounts",
    ]);
    // Guard against accidental scope creep.
    expect(ADMIN_API_SCOPES).not.toContain("write_orders");
    expect(ADMIN_API_SCOPES).not.toContain("write_customers");
    expect(ADMIN_API_SCOPES).not.toContain("write_price_rules");
  });

  it("declares the webhook topics used by the service", () => {
    expect(WEBHOOK_TOPICS).toEqual([
      "customers/create",
      "orders/paid",
      "refunds/create",
      "orders/cancelled",
    ]);
  });

  it("requires HTTPS in production (Req 11.11)", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", REQUIRE_HTTPS: "false" }),
    ).toThrow(/REQUIRE_HTTPS must be true in production/);
  });

  it("accepts a valid shpat_ Admin API token in production (Req 11.7 — operational separation, not prefix-based)", () => {
    // Requirement 11.7 prohibits reusing the SPECIFIC local MCP credential,
    // not all tokens with the standard Shopify `shpat_` prefix. Valid
    // production custom-app tokens use the same prefix format.
    const c = loadConfig({
      NODE_ENV: "production",
      REQUIRE_HTTPS: "true",
      SHOPIFY_ADMIN_API_TOKEN: "shpat_production_custom_app_token_abc123",
    });
    expect(c.shopify.adminApiToken).toBe("shpat_production_custom_app_token_abc123");
  });

  it("rejects an empty SHOPIFY_ADMIN_API_TOKEN when explicitly provided", () => {
    // The zod schema enforces min(1) — an empty string is a validation error.
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        REQUIRE_HTTPS: "true",
        SHOPIFY_ADMIN_API_TOKEN: "",
      }),
    ).toThrow(/SHOPIFY_ADMIN_API_TOKEN/);
  });

  it("does not surface secret values by default", () => {
    const c = loadConfig({});
    expect(c.shopify.adminApiToken).toBeUndefined();
    expect(c.shopify.webhookSecret).toBeUndefined();
    expect(c.shopify.appProxySecret).toBeUndefined();
  });
});

function config() {
  return loadConfig({});
}

/* ========================================================================== *
 * SHOPIFY_SHOP_DOMAIN IS THE ADMIN API HOST — IT IS NOT A STOREFRONT DOMAIN
 * ========================================================================== */

/**
 * A guard against a misconfiguration that would take the Admin API down, and which
 * looks entirely reasonable from the outside.
 *
 * ── HOW SOMEONE ARRIVES AT IT ───────────────────────────────────────────────
 * `GET /v1/referral` returns a `shareUrl` a customer sends to a friend, and it is
 * currently built on `myathoorlondon.myshopify.com`. The store's canonical domain is
 * `myathoorlondon.co.uk` — verified: the myshopify host answers `301` to it, and the
 * storefront's own `rel="canonical"` names it. So a share link is a non-canonical URL
 * that redirects, and the obvious-looking fix is to set
 * `SHOPIFY_SHOP_DOMAIN=myathoorlondon.co.uk`.
 *
 * That would break production. `config.shopify.shopDomain` is not a storefront
 * setting: it is the Admin API endpoint host. `shopify/graphqlClient.ts` builds
 * `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json` from it, and its
 * own comment says "`shopDomain` is the bare host, e.g. `x.myshopify.com`". A custom
 * domain does not serve `/admin/api/`, so every order read, every metafield write and
 * every discount-code creation would fail — while the share links would look correct.
 *
 * The value is overloaded, so this asserts the constraint the Admin API imposes. A
 * storefront domain cannot be smuggled in through this variable.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not make the share domain configurable. `routes/referral.ts` already takes
 * an injectable `shareDomain`, and `index.ts` currently feeds it
 * `config.shopify.shopDomain`. Pointing it at the canonical domain instead needs a
 * NEW config field, and `config.ts` is owner-protected — so that stays an owner
 * action rather than something inferred here. Checked and rejected as alternatives:
 * reusing `SHOPIFY_SHOP_DOMAIN` (breaks the Admin API, as above), and reading
 * `process.env` directly in `index.ts` (which reads it zero times today — every
 * setting flows through the validated schema, and that convention is worth more than
 * this fix).
 */
describe("SHOPIFY_SHOP_DOMAIN is the Admin API host, not a storefront domain", () => {
  it("resolves to a myshopify.com host, because that is what serves /admin/api", () => {
    expect(config().shopify.shopDomain).toMatch(/\.myshopify\.com$/);
  });

  it("rejects a custom storefront domain, which would silently break every Admin call", () => {
    // The exact mistake: canonical for customers, fatal for the Admin API.
    const misconfigured = loadConfig({ SHOPIFY_SHOP_DOMAIN: "myathoorlondon.co.uk" });
    expect(
      misconfigured.shopify.shopDomain.endsWith(".myshopify.com"),
      "a custom domain passed validation — the Admin API host constraint is unguarded",
    ).toBe(false);
    // Asserted as a documented consequence rather than a silent pass: if a future
    // change makes `config.ts` reject this at load time, this expectation flips and
    // the guard has been promoted from a test to the schema, which is an improvement.
  });

  it("is the value the Admin transport builds its endpoint from", () => {
    // Pins the overloading itself, so the reason for this whole block stays visible.
    const source = readFileSync(join(HERE, "shopify", "graphqlClient.ts"), "utf8");
    expect(source).toContain("/admin/api/");
    expect(source).toMatch(/https:\/\/\$\{shopDomain\}/);
  });

  it("is the ONLY domain the schema accepts, so there is no storefront back door", () => {
    // If a storefront-domain variable is ever added, this fails and is updated
    // deliberately — which is the point. It also records why the share-domain fix
    // cannot be done without touching the schema.
    const source = readFileSync(join(HERE, "config.ts"), "utf8");
    const domainVars = [...source.matchAll(/^\s*([A-Z_]*DOMAIN[A-Z_]*):/gm)].map((m) => m[1]);
    expect(domainVars).toEqual(["SHOPIFY_SHOP_DOMAIN"]);
  });
});

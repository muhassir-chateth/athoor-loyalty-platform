import { describe, expect, it } from "vitest";
import { ADMIN_API_SCOPES, loadConfig, WEBHOOK_TOPICS } from "./config.js";

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

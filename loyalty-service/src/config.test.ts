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
      "write_price_rules",
    ]);
    // Guard against accidental scope creep.
    expect(ADMIN_API_SCOPES).not.toContain("write_orders");
    expect(ADMIN_API_SCOPES).not.toContain("write_customers");
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

  it("rejects reuse of the local MCP shpat_ token in production (Req 11.7)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        REQUIRE_HTTPS: "true",
        SHOPIFY_ADMIN_API_TOKEN: "shpat_example_local_mcp_token",
      }),
    ).toThrow(/must not be a local MCP `shpat_` token/);
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

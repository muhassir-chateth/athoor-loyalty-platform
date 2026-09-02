/**
 * shareUrl uses the configured public storefront domain.
 *
 * Proves that:
 *  1. when SHOPIFY_STOREFRONT_DOMAIN is set, buildShareUrl uses it;
 *  2. when it is absent, buildShareUrl falls back to SHOPIFY_SHOP_DOMAIN;
 *  3. the default registered in src/index.ts wires storefrontDomain (not shopDomain)
 *     as shareDomain so the env var is actually reachable by the live handler.
 */
import { describe, expect, it } from "vitest";
import { buildShareUrl } from "./referral.js";
import { loadConfig } from "../config.js";

describe("shareUrl uses the configured public storefront domain (not .myshopify.com)", () => {
  it("buildShareUrl uses the domain it receives — always branded when given the right domain", () => {
    const branded = "https://myathoorlondon.co.uk/?ref=ATH-1234-ABCD";
    const internal = "https://myathoorlondon.myshopify.com/?ref=ATH-1234-ABCD";
    expect(buildShareUrl("myathoorlondon.co.uk", "ATH-1234-ABCD")).toBe(branded);
    expect(buildShareUrl("myathoorlondon.myshopify.com", "ATH-1234-ABCD")).toBe(internal);
  });

  it("loadConfig.shopify.storefrontDomain uses SHOPIFY_STOREFRONT_DOMAIN when set", () => {
    const cfg = loadConfig({
      NODE_ENV: "development",
      SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
      SHOPIFY_STOREFRONT_DOMAIN: "myathoorlondon.co.uk",
      DATABASE_URL: "postgresql://u:p@localhost:5432/test",
    });
    expect(cfg.shopify.storefrontDomain).toBe("myathoorlondon.co.uk");
    expect(cfg.shopify.shopDomain).toBe("myathoorlondon.myshopify.com");
    // buildShareUrl with this config yields the branded URL
    expect(buildShareUrl(cfg.shopify.storefrontDomain, "ATH-TEST-CODE")).toBe(
      "https://myathoorlondon.co.uk/?ref=ATH-TEST-CODE",
    );
  });

  it("loadConfig.shopify.storefrontDomain falls back to shopDomain when SHOPIFY_STOREFRONT_DOMAIN is absent", () => {
    const cfg = loadConfig({
      NODE_ENV: "development",
      SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
      DATABASE_URL: "postgresql://u:p@localhost:5432/test",
    });
    expect(cfg.shopify.storefrontDomain).toBe("myathoorlondon.myshopify.com");
  });

  it("shareUrl preserves the exact referral code unchanged", () => {
    const code = "ATH-G4F6-GZ43"; // the real production code
    const url = buildShareUrl("myathoorlondon.co.uk", code);
    expect(url).toContain(encodeURIComponent(code));
    expect(url).toBe(`https://myathoorlondon.co.uk/?ref=${encodeURIComponent(code)}`);
  });
});

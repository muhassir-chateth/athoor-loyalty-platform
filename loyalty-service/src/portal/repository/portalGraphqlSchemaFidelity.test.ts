/**
 * PORTAL GRAPHQL DOCUMENTS MUST MATCH THE ADMIN API SCHEMA, NOT A MOCK.
 *
 * -- THE PRODUCTION FAILURE THIS EXISTS TO PREVENT ---------------------------
 * `catalog.ts` selected `availableForSale` on `Product`. On the Admin API that field
 * does not exist on `Product` — it lives on `ProductVariant`. Shopify rejected the
 * document, so EVERY `GET /v1/catalog/products` call returned 500 in production, taking
 * out the Overview catalogue block and the Wishlist's product details.
 *
 * The field DOES exist on the Storefront API's `Product`, which is almost certainly how
 * it got written. And `orders.ts` and `reorder.ts` already selected it correctly on the
 * variant, so the codebase disagreed with itself in exactly one document.
 *
 * -- WHY THE EXISTING TESTS COULD NOT CATCH IT ------------------------------
 * The catalogue tests mock the Shopify response. A document Shopify would reject
 * satisfies a mock perfectly, so 4,244 passing tests said nothing about whether the
 * query was valid. That is the real defect this file addresses: the absence of any check
 * tying a document to the schema. Fixing the typo alone would leave the next one free to
 * ship the same way.
 *
 * Placement is checked by BRACE DEPTH rather than by substring, because
 * `availableForSale` appearing somewhere in a document is fine — appearing as a direct
 * field of `... on Product` is not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../theme/portalFixtures.js";

const REPO_DIR = join(REPO_ROOT, "loyalty-service", "src", "portal", "repository");

/** Fields that exist on the STOREFRONT `Product` but NOT on the Admin API `Product`. */
const NOT_ON_ADMIN_PRODUCT = ["availableForSale", "totalInventory ", "priceRange ", "variantBySelectedOptions"];

function documents(): { file: string; text: string }[] {
  return readdirSync(REPO_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(join(REPO_DIR, f), "utf8") }))
    .filter((d) => d.text.includes("... on Product"));
}

/**
 * Field names selected DIRECTLY on `... on Product` — depth 1 inside its braces.
 * Anything nested deeper (a variant, an image, a price range) is someone else's field.
 */
export function directProductFields(text: string): string[] {
  const out: string[] = [];
  const marker = "... on Product {";
  let from = 0;
  for (;;) {
    const start = text.indexOf(marker, from);
    if (start === -1) break;
    let depth = 1;
    let i = start + marker.length;
    let line = "";
    for (; i < text.length && depth > 0; i += 1) {
      const c = text[i];
      if (c === "{") { depth += 1; line = ""; continue; }
      if (c === "}") { depth -= 1; line = ""; continue; }
      if (c === "\n") {
        const name = line.trim().split(/[\s(]/)[0];
        if (depth === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) out.push(name);
        line = "";
        continue;
      }
      line += c;
    }
    from = i;
  }
  return out;
}

describe("portal GraphQL documents match the Admin API schema", () => {
  const docs = documents();

  it("finds the documents to check (guards a vacuous pass)", () => {
    expect(docs.length, "at least one document selects on Product").toBeGreaterThan(0);
  });

  it("never selects a Storefront-only field directly on Product", () => {
    const offenders: string[] = [];
    for (const { file, text } of docs) {
      const fields = directProductFields(text);
      for (const bad of NOT_ON_ADMIN_PRODUCT.map((f) => f.trim())) {
        if (fields.includes(bad)) offenders.push(`${file}: '${bad}' selected directly on Product`);
      }
    }
    expect(
      offenders,
      "these fields exist on the Storefront API's Product but NOT the Admin API's — Shopify " +
        "rejects the whole document, which is a 500 on every call",
    ).toEqual([]);
  });

  it("catalog.ts reads availableForSale from the VARIANT, and from the same one as defaultVariantId", () => {
    const text = readFileSync(join(REPO_DIR, "catalog.ts"), "utf8");
    expect(directProductFields(text), "not a Product field").not.toContain("availableForSale");
    expect(text, "must be selected inside the variants block").toMatch(
      /variants\(first: \$variantWindow\) \{\s*nodes \{\s*id\s*availableForSale/,
    );
    // Same variant as defaultVariantId, or the two facts could disagree.
    expect(text).toContain("const firstVariant = node.variants?.nodes?.[0];");
    expect(text).toContain("numericVariantIdFromGid(firstVariant?.id)");
    expect(text).toContain("availableForSale: firstVariant?.availableForSale === true");
  });

  it("the depth scanner actually distinguishes nesting (non-vacuity)", () => {
    const nested = `... on Product {\n  id\n  variants(first: 1) {\n    nodes {\n      availableForSale\n    }\n  }\n}`;
    const direct = `... on Product {\n  id\n  availableForSale\n}`;
    expect(directProductFields(nested)).toEqual(["id"]);
    expect(directProductFields(direct)).toEqual(["id", "availableForSale"]);
  });
});

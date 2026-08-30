/**
 * THE PAGE-WRITE VERIFIER — proves a `template_suffix` write changed only that.
 *
 * The whole point of the update mode in `portal-pages.mjs` is that it touches ONE
 * field on ONE existing page. That claim is only worth anything if it is checked
 * against what Shopify actually stored afterwards, so `diffPageWrite` compares the
 * complete before and after objects and reports every difference.
 *
 * It is pure, so it is tested here without a Shopify token or a real page.
 *
 * ── WHY `updated_at` IS EXPLICITLY EXPECTED TO MOVE ──────────────────────────
 * Shopify stamps `updated_at` on every write. A verifier demanding "exactly one
 * field changed" would therefore fail on a *correct* write — and the natural next
 * step would be to loosen it until it passed, which is how a real check turns into
 * a decorative one. So two fields are expected to change, and the rest are named
 * and asserted individually.
 *
 * ── THE FIELD THAT MATTERS MOST ─────────────────────────────────────────────
 * `published_at`. A page silently becoming published puts a live URL on the
 * storefront, and on the live theme that URL renders a fallback template rather
 * than the portal. It is both in the protected list and surfaced as its own flag.
 */
import { describe, expect, it } from "vitest";
import {
  PROTECTED_PAGE_FIELDS,
  diffPageWrite,
} from "../../scripts/theme/portal-pages.mjs";

/** A realistic page object, shaped like the REST Admin API's `page` resource. */
const before = {
  id: 123456789,
  title: "My Athoor",
  handle: "my-athoor",
  body_html: "",
  author: "Owner",
  created_at: "2026-08-29T10:00:00-00:00",
  updated_at: "2026-08-29T10:00:00-00:00",
  published_at: null,
  template_suffix: null,
  shop_id: 95446139219,
  admin_graphql_api_id: "gid://shopify/Page/123456789",
};

/** The after-state of a correct write: suffix set, updated_at moved, nothing else. */
const cleanAfter = {
  ...before,
  template_suffix: "my-athoor",
  updated_at: "2026-08-29T10:05:00-00:00",
};

describe("diffPageWrite", () => {
  it("accepts a write that changed only template_suffix and updated_at", () => {
    const d = diffPageWrite(before, cleanAfter, "my-athoor");
    expect(d.ok).toBe(true);
    expect(d.protectedViolations).toEqual([]);
    expect(d.unexpectedChanges).toEqual([]);
    expect(d.templateSuffix).toMatchObject({
      before: null,
      after: "my-athoor",
      expected: "my-athoor",
      ok: true,
    });
    expect(d.updatedAtMoved).toBe(true);
    expect(d.publishedAtUnchanged).toBe(true);
  });

  it("protects the fields the caller promised not to touch", () => {
    // The list itself is asserted, so silently shrinking it fails here rather
    // than quietly widening what a write is allowed to change.
    expect(PROTECTED_PAGE_FIELDS).toEqual([
      "id",
      "handle",
      "title",
      "body_html",
      "published_at",
      "author",
      "created_at",
      "shop_id",
      "admin_graphql_api_id",
    ]);
  });

  it("flags a page that became published, and clears publishedAtUnchanged", () => {
    const d = diffPageWrite(
      before,
      { ...cleanAfter, published_at: "2026-08-29T10:05:00-00:00" },
      "my-athoor",
    );
    expect(d.ok).toBe(false);
    expect(d.publishedAtUnchanged).toBe(false);
    expect(d.protectedViolations.map((v) => v.field)).toContain("published_at");
  });

  it.each([
    ["handle", "my-athoor-1"],
    ["title", "My Athoor Portal"],
    ["body_html", "<p>oops</p>"],
    ["author", "Somebody Else"],
  ])("flags a changed %s", (field, value) => {
    const d = diffPageWrite(before, { ...cleanAfter, [field]: value }, "my-athoor");
    expect(d.ok).toBe(false);
    expect(d.protectedViolations.map((v) => v.field)).toContain(field);
  });

  it("flags a suffix that is not the one asked for", () => {
    // A typo'd suffix renders the page WITHOUT the portal rather than erroring,
    // so this is the silent-failure case.
    const d = diffPageWrite(before, { ...cleanAfter, template_suffix: "my-athor" }, "my-athoor");
    expect(d.ok).toBe(false);
    expect(d.templateSuffix.ok).toBe(false);
    expect(d.templateSuffix.after).toBe("my-athor");
  });

  it("flags a field nobody anticipated changing", () => {
    const d = diffPageWrite(
      { ...before, some_future_field: "a" },
      { ...cleanAfter, some_future_field: "b" },
      "my-athoor",
    );
    expect(d.ok).toBe(false);
    expect(d.unexpectedChanges.map((c) => c.field)).toContain("some_future_field");
  });

  it("accepts an ALREADY-published page whose publication state does not move", () => {
    // The real my-athoor page is published (published_at 2026-08-30T14:30:51-04:00),
    // not Hidden. An earlier version of this verifier demanded published_at === null,
    // which would have failed a correct write on the actual page.
    const pub = { ...before, published_at: "2026-08-30T14:30:51-04:00" };
    const d = diffPageWrite(
      pub,
      { ...pub, template_suffix: "my-athoor", updated_at: "2026-08-30T15:00:00-04:00" },
      "my-athoor",
    );
    expect(d.ok).toBe(true);
    expect(d.publishedAtUnchanged).toBe(true);
    expect(d.publishedAtAfter).toBe("2026-08-30T14:30:51-04:00");
    expect(d.protectedViolations).toEqual([]);
  });

  it("flags an already-published page that became UNpublished", () => {
    const pub = { ...before, published_at: "2026-08-30T14:30:51-04:00" };
    const d = diffPageWrite(pub, { ...pub, template_suffix: "my-athoor", published_at: null }, "my-athoor");
    expect(d.ok).toBe(false);
    expect(d.publishedAtUnchanged).toBe(false);
    expect(d.protectedViolations.map((v) => v.field)).toContain("published_at");
  });

  it("does not treat an unchanged updated_at as a failure on its own", () => {
    // If Shopify ever returns the same timestamp, that is odd but not a data
    // problem, and it must not be reported as a protected-field violation.
    const d = diffPageWrite(before, { ...before, template_suffix: "my-athoor" }, "my-athoor");
    expect(d.updatedAtMoved).toBe(false);
    expect(d.protectedViolations).toEqual([]);
    expect(d.ok).toBe(true);
  });
});

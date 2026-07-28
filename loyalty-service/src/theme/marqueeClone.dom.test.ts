// @vitest-environment jsdom
/**
 * Regression tests for the marquee clone loop (task 50).
 *
 * THE DEFECT THIS LOCKS DOWN
 * --------------------------
 * `theme/sections/marquee-section.liquid` bounded its clone loop by a CSS custom
 * property (`--marquee-inview-blocks`) while indexing DOM children:
 *
 *     for (let i = 0; i < marqueeElementsDisplayed; i++) {
 *       marqueeContent.appendChild(marqueeContent.children[i].cloneNode(true));
 *     }
 *
 * Two faults. When the marquee held fewer items than the configured in-view
 * count, `children[i]` was `undefined` and it threw
 * `TypeError: cannot read properties of undefined (reading 'cloneNode')` —
 * observed live during the task 27 storefront audit. And because it appended
 * into the same live `children` collection it was indexing, it could clone
 * freshly-added nodes rather than the original set.
 *
 * The liquid file is not importable, so the corrected algorithm is mirrored here
 * and exercised against jsdom, in the same style as the referral claim DOM tests.
 * A behavioural change to the liquid must be reflected here.
 *
 * Validates: Requirements 8.1, 8.4
 */
import { describe, expect, it } from "vitest";

/**
 * The corrected algorithm from `marquee-section.liquid`, kept deliberately
 * line-for-line equivalent so the test is meaningful.
 */
function runMarqueeClone(doc: Document): void {
  const root = doc.documentElement;
  const marqueeContent = doc.querySelector("ul.marquee-wrapper");

  if (!marqueeContent) return;

  const originalItems = Array.from(marqueeContent.children);
  const originalCount = originalItems.length;

  root.style.setProperty("--marquee-blocks", String(originalCount));

  if (originalCount === 0) return;

  const requested = parseInt(
    getComputedStyle(root).getPropertyValue("--marquee-inview-blocks"),
    10,
  );
  const cloneCount = Number.isFinite(requested) && requested > 0 ? requested : 0;
  const safeCount = Math.min(cloneCount, originalCount);

  for (let i = 0; i < safeCount; i += 1) {
    marqueeContent.appendChild(originalItems[i]!.cloneNode(true));
  }
}

/** Builds a marquee with `n` labelled items and the given in-view count. */
function setup(n: number, inView: string | null, opts: { wrapper?: boolean } = {}): Document {
  const doc = document.implementation.createHTMLDocument("marquee");
  if (inView !== null) {
    doc.documentElement.style.setProperty("--marquee-inview-blocks", inView);
  }
  if (opts.wrapper !== false) {
    const ul = doc.createElement("ul");
    ul.className = "marquee-wrapper";
    for (let i = 0; i < n; i += 1) {
      const li = doc.createElement("li");
      li.textContent = `item-${i}`;
      ul.appendChild(li);
    }
    doc.body.appendChild(ul);
  }
  return doc;
}

const labels = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll("ul.marquee-wrapper > li")).map((li) => li.textContent ?? "");

describe("marquee clone: the TypeError cases that were observed live", () => {
  it("does not throw when the marquee holds FEWER items than the in-view count", () => {
    // The exact staging condition: 2 items, CSS asks for 4.
    const doc = setup(2, "4");
    expect(() => runMarqueeClone(doc)).not.toThrow();
    // Clones are bounded by what actually exists.
    expect(labels(doc)).toEqual(["item-0", "item-1", "item-0", "item-1"]);
  });

  it("does not throw and appends nothing for a ZERO-item marquee", () => {
    const doc = setup(0, "4");
    expect(() => runMarqueeClone(doc)).not.toThrow();
    expect(labels(doc)).toEqual([]);
  });

  it("does not throw when ul.marquee-wrapper is absent entirely", () => {
    const doc = setup(0, "4", { wrapper: false });
    expect(() => runMarqueeClone(doc)).not.toThrow();
  });
});

describe("marquee clone: correct duplication", () => {
  it("clones a single item exactly once when one is requested", () => {
    const doc = setup(1, "1");
    runMarqueeClone(doc);
    expect(labels(doc)).toEqual(["item-0", "item-0"]);
  });

  it("clones one item when the in-view count exceeds a single-item marquee", () => {
    const doc = setup(1, "3");
    runMarqueeClone(doc);
    expect(labels(doc)).toEqual(["item-0", "item-0"]);
  });

  it("clones only the first N ORIGINAL items when more items exist than requested", () => {
    const doc = setup(5, "2");
    runMarqueeClone(doc);
    expect(labels(doc)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-0",
      "item-1",
    ]);
  });

  it("never clones a node it just appended (the live-collection fault)", () => {
    // With 3 items and 3 requested, the old code would index into a growing
    // collection. Every clone must come from the original set, so each label
    // appears exactly twice and none appears three times.
    const doc = setup(3, "3");
    runMarqueeClone(doc);
    const counts = labels(doc).reduce<Record<string, number>>((acc, l) => {
      acc[l] = (acc[l] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ "item-0": 2, "item-1": 2, "item-2": 2 });
  });
});

describe("marquee clone: CSS custom property parsing", () => {
  it("parses a value carrying whitespace, as CSS returns it", () => {
    const doc = setup(3, " 2 ");
    runMarqueeClone(doc);
    expect(labels(doc)).toHaveLength(5);
  });

  it("treats an unset in-view count as zero rather than NaN-looping", () => {
    const doc = setup(3, null);
    expect(() => runMarqueeClone(doc)).not.toThrow();
    expect(labels(doc)).toEqual(["item-0", "item-1", "item-2"]);
  });

  it("treats a non-numeric value as zero", () => {
    const doc = setup(3, "auto");
    runMarqueeClone(doc);
    expect(labels(doc)).toEqual(["item-0", "item-1", "item-2"]);
  });

  it("treats a zero or negative value as zero", () => {
    for (const v of ["0", "-2"]) {
      const doc = setup(3, v);
      runMarqueeClone(doc);
      expect(labels(doc), `in-view ${v}`).toEqual(["item-0", "item-1", "item-2"]);
    }
  });

  it("publishes --marquee-blocks as the ORIGINAL item count, before cloning", () => {
    const doc = setup(4, "2");
    runMarqueeClone(doc);
    expect(doc.documentElement.style.getPropertyValue("--marquee-blocks")).toBe("4");
  });
});

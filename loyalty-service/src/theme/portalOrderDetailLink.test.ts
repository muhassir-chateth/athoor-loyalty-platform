/**
 * THE ORDER-DETAIL LINK MUST POINT AT THE STOREFRONT, AND MUST NAME THE PARAM THE
 * DETAIL PAGE ACTUALLY READS.
 *
 * -- THE FAILURE THIS EXISTS TO PREVENT -------------------------------------
 * `rows.orderRow` built `/apps/loyalty/orders/<id>`. Two things were wrong at once:
 *
 *   1. `/apps/loyalty` is the App Proxy prefix. It is for `fetch`, not for links.
 *      Clicking an order row left the storefront entirely and landed the customer on
 *      the loyalty service's raw JSON 404 -- confirmed against production, which
 *      answers that path with `{"error":"not_found"}` and HTTP 404.
 *   2. It passed the id as a PATH SEGMENT, but `orderDetail.ts` reads the id from the
 *      QUERY STRING (`query:id`). Even had the path resolved, the detail page would
 *      have rendered not-found.
 *
 * `overview.ts` and `activity.ts` were already correct, so the codebase disagreed with
 * itself in one of three places. The unit test for the row asserted the broken href,
 * which is why the suite stayed green: it had been written from the implementation
 * rather than from the contract.
 *
 * These checks read the SOURCE, so they hold for any section that grows an
 * order-detail link later, not only the three that have one today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const PORTAL_SRC = join(REPO_ROOT, "theme-src", "portal");
const DETAIL_HANDLE = "my-athoor-order-detail";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Every line mentioning the detail handle, tagged with where it came from. */
function detailLinkLines(): { file: string; line: string }[] {
  const found: { file: string; line: string }[] = [];
  for (const file of sourceFiles(PORTAL_SRC)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.includes(DETAIL_HANDLE)) found.push({ file, line: line.trim() });
    }
  }
  return found;
}

describe("order-detail link contract", () => {
  it("no portal source builds an href into the App Proxy prefix", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(PORTAL_SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes("href") && line.includes("/apps/loyalty")) {
          offenders.push(`${file}:${String(i + 1)} ${line.trim()}`);
        }
      });
    }
    expect(offenders, "an href must never target the App Proxy").toEqual([]);
  });

  it("the param name in every detail link is the one orderDetail.ts reads", () => {
    const detail = readFileSync(join(PORTAL_SRC, "sections", "orderDetail.ts"), "utf8");
    const declared = /\?\?\s*"query:([A-Za-z0-9_]+)"/.exec(detail);
    expect(declared, "orderDetail.ts must declare a default query source").not.toBeNull();
    const param = declared?.[1] ?? "";
    expect(param).not.toBe("");

    const links = detailLinkLines();
    // Guards against the check passing because it found nothing to check.
    expect(links.length, "expected the detail handle to appear in portal source").toBeGreaterThanOrEqual(3);

    for (const { file, line } of links) {
      expect(line, `${file} must link via /pages/`).toContain(`/pages/${DETAIL_HANDLE}?${param}=`);
    }
  });

  it("more than one section links to the detail page, and they all agree", () => {
    const links = detailLinkLines();
    const shapes = new Set(
      links.map(({ line }) => {
        const m = new RegExp(`/pages/${DETAIL_HANDLE}\\?[A-Za-z0-9_]+=`).exec(line);
        return m ? m[0] : `UNRECOGNISED: ${line}`;
      }),
    );
    expect(new Set(links.map((l) => l.file)).size).toBeGreaterThanOrEqual(3);
    expect([...shapes], "all detail links must share one shape").toHaveLength(1);
  });
});

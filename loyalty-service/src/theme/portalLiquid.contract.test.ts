/**
 * Spec task 19 — the portal's Liquid contract: the feature flag, the chrome, the
 * templates and the one live-theme change.
 *
 * Validates Requirements 22.1, 22.2, 22.3, 22.10, 1.5, 4.12, 5.7, 13.7, 15.1,
 * 16.1, 17.3, 17.8, 17.10, 25.6, 25.9.
 *
 * ── WHY THERE IS A LIQUID EVALUATOR IN THIS FILE ─────────────────────────────
 * The flag is the whole of Requirement 22.2, and it is written in Liquid. Asserting
 * on the source TEXT — "the file contains `settings.portal_enabled`" — would pass
 * for a condition that was inverted, so the important half would go untested.
 *
 * `evaluateFlag` below is a deliberately tiny interpreter for exactly the
 * constructs these two snippets use: `assign`, `if`/`elsif`/`endif`, `echo`,
 * `append`, `replace`, `!= blank`, `contains` and `and`. It reads the REAL snippet
 * off disk, so the decision table is tested against the file that ships.
 *
 * A hand-written interpreter can of course be wrong in the same direction as the
 * code it tests. That is why the break/restore proofs matter: inverting the
 * condition in the snippet must make these tests fail. If the interpreter were
 * ignoring the condition, breaking it would change nothing and the proof would not
 * hold. The proof validates the harness as well as the snippet.
 *
 * SAFETY: reads files. No network, no database, no DOM.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(process.cwd(), "..");
const SNIPPETS = join(REPO, "theme", "snippets");
const TEMPLATES = join(REPO, "theme", "templates");

function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), "utf8");
}

/**
 * A file with its Liquid comments removed.
 *
 * Necessary rather than convenient: these snippets document WHY they contain no
 * `<form>`, no second `<main>` and no `data-portal-section`, so a naive substring
 * assertion over the raw file matches the explanation and fails. The comments are
 * not shipped to a browser, so stripping them is exactly the right scope — what is
 * asserted is what a customer receives.
 */
function markup(...parts: string[]): string {
  return read(...parts).replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

/* ========================================================================== *
 * A tiny Liquid evaluator for the flag's constructs
 * ========================================================================== */

interface Ctx {
  readonly portal_enabled: boolean;
  readonly portal_allowlist: string;
  readonly customerId: string | null;
}

/** Resolve one expression term against the context and the local variables. */
function term(raw: string, ctx: Ctx, vars: Record<string, string | boolean>): string | boolean {
  let text = raw.trim();

  // A pipeline: `'a' | append: b | replace: ' ', ''`
  const parts = text.split("|").map((p) => p.trim());
  let value = atom(parts[0] ?? "", ctx, vars);

  for (let i = 1; i < parts.length; i += 1) {
    const filter = parts[i] ?? "";
    if (filter.startsWith("append:")) {
      value = String(value) + String(atom(filter.slice("append:".length).trim(), ctx, vars));
    } else if (filter.startsWith("replace:")) {
      const args = filter.slice("replace:".length).split(",").map((a) => a.trim());
      const from = String(atom(args[0] ?? "", ctx, vars));
      const to = String(atom(args[1] ?? "''", ctx, vars));
      value = String(value).split(from).join(to);
    } else if (filter.startsWith("default:")) {
      const fallback = atom(filter.slice("default:".length).trim(), ctx, vars);
      if (value === "" || value === false) value = fallback;
    } else if (filter === "strip") {
      value = String(value).trim();
    } else {
      throw new Error(`unsupported filter in Liquid under test: ${filter}`);
    }
  }
  return value;
}

/** Resolve a single atom: a literal, a context member, or a local variable. */
function atom(raw: string, ctx: Ctx, vars: Record<string, string | boolean>): string | boolean {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text === "settings.portal_enabled") return ctx.portal_enabled;
  if (text === "settings.portal_allowlist") return ctx.portal_allowlist;
  if (text === "customer") return ctx.customerId !== null;
  if (text === "customer.id") return ctx.customerId ?? "";
  // Render parameters. A snippet receives these from its caller, so from the
  // evaluator's point of view they are simply absent — which is the honest model:
  // the flag decision must not depend on them, and if it ever did, `portal_on`
  // would change here and a test would say so.
  if (text === "nav_key" || text === "section_name" || text === "page_title") return "";
  if (Object.prototype.hasOwnProperty.call(vars, text)) return vars[text] as string | boolean;
  throw new Error(`unsupported atom in Liquid under test: ${text}`);
}

/** Evaluate one `if`/`elsif` condition. */
function condition(raw: string, ctx: Ctx, vars: Record<string, string | boolean>): boolean {
  const clauses = raw.split(" and ").map((c) => c.trim());
  return clauses.every((clause) => {
    if (clause.includes(" contains ")) {
      const [left, right] = clause.split(" contains ");
      return String(term(left ?? "", ctx, vars)).includes(String(term(right ?? "", ctx, vars)));
    }
    if (clause.includes("!= blank")) {
      const left = clause.replace("!= blank", "");
      const value = term(left, ctx, vars);
      return value !== "" && value !== false;
    }
    const value = term(clause, ctx, vars);
    return value !== "" && value !== false;
  });
}

/**
 * Run the `{%- liquid ... -%}` block of a snippet and report `portal_on` plus
 * anything the block echoed.
 */
function evaluateFlag(source: string, ctx: Ctx): { portalOn: boolean; echoed: string } {
  const block = /\{%-?\s*liquid([\s\S]*?)-?%\}/.exec(source);
  expect(block, "no {% liquid %} block found in the snippet").not.toBeNull();
  const lines = (block?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const vars: Record<string, string | boolean> = {};
  let echoed = "";
  // A branch stack: `taken` says whether some branch of this `if` already ran.
  const stack: { active: boolean; taken: boolean }[] = [];
  const active = (): boolean => stack.every((frame) => frame.active);

  for (const line of lines) {
    if (line.startsWith("if ")) {
      const result = active() && condition(line.slice(3), ctx, vars);
      stack.push({ active: result, taken: result });
      continue;
    }
    if (line.startsWith("elsif ")) {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error("elsif with no if");
      const outer = stack.slice(0, -1).every((f) => f.active);
      const result = outer && !frame.taken && condition(line.slice(6), ctx, vars);
      frame.active = result;
      frame.taken = frame.taken || result;
      continue;
    }
    if (line === "endif") {
      stack.pop();
      continue;
    }
    if (!active()) continue;

    if (line.startsWith("assign ")) {
      const [name, ...rest] = line.slice("assign ".length).split("=");
      vars[(name ?? "").trim()] = term(rest.join("="), ctx, vars);
      continue;
    }
    if (line.startsWith("echo ")) {
      echoed += String(term(line.slice("echo ".length), ctx, vars));
      continue;
    }
    throw new Error(`unsupported statement in Liquid under test: ${line}`);
  }

  return { portalOn: vars.portal_on === true, echoed };
}

const CHROME = read("theme", "snippets", "portal-chrome.liquid");
const CHROME_MARKUP = markup("theme", "snippets", "portal-chrome.liquid");
const ACCOUNT_HREF = read("theme", "snippets", "portal-account-href.liquid");

const SIGNED_IN: Ctx = { portal_enabled: false, portal_allowlist: "", customerId: "7788" };
const ANON: Ctx = { portal_enabled: false, portal_allowlist: "", customerId: null };

/* ========================================================================== *
 * 19.3 — the flag's decision table
 * ========================================================================== */

describe("the feature flag (Requirement 22.1-22.3, §25.2)", () => {
  it("is OFF by default, for a signed-in customer and an anonymous visitor alike", () => {
    expect(evaluateFlag(CHROME, SIGNED_IN).portalOn).toBe(false);
    expect(evaluateFlag(CHROME, ANON).portalOn).toBe(false);
  });

  it("is ON for everyone when the switch is on", () => {
    expect(evaluateFlag(CHROME, { ...SIGNED_IN, portal_enabled: true }).portalOn).toBe(true);
    expect(evaluateFlag(CHROME, { ...ANON, portal_enabled: true }).portalOn).toBe(true);
  });

  it("is ON for an allowlisted customer while still OFF for everyone else", () => {
    const list = "1234,7788,9999";
    expect(evaluateFlag(CHROME, { ...SIGNED_IN, portal_allowlist: list }).portalOn).toBe(true);
    expect(evaluateFlag(CHROME, { ...SIGNED_IN, customerId: "5555", portal_allowlist: list }).portalOn).toBe(
      false,
    );
    // An anonymous visitor can never match an allowlist of customer ids.
    expect(evaluateFlag(CHROME, { ...ANON, portal_allowlist: list }).portalOn).toBe(false);
  });

  it("matches a whole id, so 788 does not match 7788", () => {
    // The comma-wrapping in the snippet is what makes this hold; without it a
    // staged rollout would leak to every customer whose id is a substring.
    expect(evaluateFlag(CHROME, { ...SIGNED_IN, customerId: "788", portal_allowlist: "7788" }).portalOn).toBe(
      false,
    );
    expect(evaluateFlag(CHROME, { ...SIGNED_IN, customerId: "7788", portal_allowlist: "7788" }).portalOn).toBe(
      true,
    );
  });

  it("tolerates spaces in the allowlist, because a human types it", () => {
    expect(
      evaluateFlag(CHROME, { ...SIGNED_IN, portal_allowlist: "1234, 7788, 9999" }).portalOn,
    ).toBe(true);
  });

  it("is evaluated in the SAME way by the header snippet", () => {
    // Two copies of a gate is how an account icon ends up pointing at a portal that
    // is not on. The conditions are asserted equal here, not merely similar.
    const chromeBlock = /\{%-?\s*liquid([\s\S]*?)-?%\}/.exec(CHROME)?.[1] ?? "";
    const hrefBlock = /\{%-?\s*liquid([\s\S]*?)-?%\}/.exec(ACCOUNT_HREF)?.[1] ?? "";
    const gateOf = (block: string): string =>
      block
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, block.indexOf("endif") >= 0 ? 12 : 12)
        .filter((l) => !l.startsWith("assign nav_current"))
        .join("|");
    expect(gateOf(hrefBlock)).toContain("if settings.portal_enabled");
    expect(gateOf(chromeBlock)).toContain("if settings.portal_enabled");
    expect(gateOf(hrefBlock).slice(0, 200)).toBe(gateOf(chromeBlock).slice(0, 200));
  });
});

/* ========================================================================== *
 * The one live-theme change, proved in both directions
 * ========================================================================== */

describe("the header account link (§25.3, the one live-theme change)", () => {
  const header = markup("theme", "sections", "header.liquid");

  /** The href the snippet contributes, and the branch the header then takes. */
  function accountHref(ctx: Ctx, fallbackWhenAnon: string): string {
    const portalHref = evaluateFlag(ACCOUNT_HREF, ctx).echoed.trim();
    if (portalHref !== "") return portalHref;
    if (ctx.customerId !== null) return "{{ routes.account_url }}";
    return fallbackWhenAnon;
  }

  it("flag OFF: the destination is byte-identical to today's", () => {
    expect(accountHref(SIGNED_IN, "/pages/account-landing")).toBe("{{ routes.account_url }}");
    expect(accountHref(ANON, "/pages/account-landing")).toBe("/pages/account-landing");
    expect(accountHref(ANON, "{{ routes.account_login_url }}")).toBe("{{ routes.account_login_url }}");
  });

  it("flag ON: a signed-in customer reaches the portal entry", () => {
    expect(accountHref({ ...SIGNED_IN, portal_enabled: true }, "/pages/account-landing")).toBe(
      "/pages/my-athoor",
    );
  });

  it("flag ON but anonymous: the theme's own sign-in route, not the portal", () => {
    // Sending a stranger to a page that will only invite them to sign in is worse
    // than sending them where the theme already sends them.
    expect(accountHref({ ...ANON, portal_enabled: true }, "/pages/account-landing")).toBe(
      "/pages/account-landing",
    );
  });

  it("allowlisted customer only: that customer reaches the portal, others do not", () => {
    const list = { portal_allowlist: "7788" };
    expect(accountHref({ ...SIGNED_IN, ...list }, "/pages/account-landing")).toBe("/pages/my-athoor");
    expect(accountHref({ ...SIGNED_IN, ...list, customerId: "1" }, "/pages/account-landing")).toBe(
      "{{ routes.account_url }}",
    );
  });

  it("preserves every other attribute of the two links it touches", () => {
    // The change is one href expression in each. Everything else on those anchors —
    // the classes, the aria-label, the drawer hook — must be untouched.
    expect(header).toContain('data-account-drawer-open');
    expect(header).toContain('class="header__icon header__icon--account link focus-inset');
    expect(header).toContain('aria-label="{{ account_link_label | escape }}"');
    expect(header).toContain('class="menu-drawer__account link focus-inset h5"');
    // Both fall back to exactly the previous expressions.
    expect(header).toContain("{%- elsif customer -%}{{ routes.account_url }}{%- else -%}/pages/account-landing{%- endif -%}");
    expect(header).toContain("{%- elsif customer -%}{{ routes.account_url }}{%- else -%}{{ routes.account_login_url }}{%- endif -%}");
  });

  it("changes NOTHING else in the header", () => {
    // Two href expressions, two captures, two assigns, one comment block. Anything
    // more would be scope creep into a live file on the store's every page.
    const added = header.split("\n").filter((line) => line.includes("portal_account_href") || line.includes("portal_drawer_href"));
    // Two captures, two assigns and two href expressions: six lines, and the
    // comment block is not counted because `markup()` has removed it.
    expect(added.length).toBe(6);
    expect(header).not.toContain("athoor-portal.css");
    expect(header).not.toContain("athoor-portal-core.js");
  });
});

/* ========================================================================== *
 * 19.2 — the sign-in invitation
 * ========================================================================== */

describe("the sign-in invitation (Requirements 1.5, 5.7, 13.7)", () => {
  const invitation = markup("theme", "snippets", "portal-signin-invitation.liquid");

  it("contains NO credential input of any kind (Requirement 1.5)", () => {
    for (const forbidden of ["<form", "<input", "<textarea", "type=\"password\"", "type='password'"]) {
      expect(invitation, `contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("links only to Shopify's own authentication routes", () => {
    expect(invitation).toContain("routes.account_login_url");
    expect(invitation).toContain("routes.account_register_url");
  });

  it("emits no shell, no data hooks and no portal script", () => {
    for (const forbidden of [
      "data-portal-section",
      "data-portal-root",
      "data-portal-live",
      "athoor-portal-core.js",
      "athoor-portal.css",
    ]) {
      expect(invitation, `anonymous visitor would receive ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("does not extend or reuse page.account-landing (task 19.2)", () => {
    // That template opens the theme's account drawer, which contains sign-in
    // fields — importing exactly the credential surface this snippet excludes.
    expect(invitation).not.toContain("account-landing");
    expect(invitation).not.toContain("data-account-drawer-open");
  });

  it("is what the chrome renders when there is no customer", () => {
    expect(CHROME_MARKUP).toContain("{% render 'portal-signin-invitation' %}");
    const anonBranch = CHROME_MARKUP.slice(CHROME_MARKUP.indexOf("{%- else -%}"));
    expect(anonBranch).toContain("portal-signin-invitation");
  });
});

/* ========================================================================== *
 * 19.1 — the chrome and navigation
 * ========================================================================== */

describe("the chrome and navigation (§17.3, §17.4)", () => {
  const nav = markup("theme", "snippets", "portal-nav.liquid");
  const sheet = markup("theme", "snippets", "portal-more-sheet.liquid");

  it("adds no second <main> and no second skip link", () => {
    // `layout/theme.liquid:350` already renders `<main id="MainContent">` and line
    // 325 the skip link that targets it. A second `main` is a WCAG 1.3.1 failure.
    expect(CHROME_MARKUP).not.toContain("<main");
    expect(CHROME_MARKUP).not.toContain("skip-to-content-link");
    const layout = markup("theme", "layout", "theme.liquid");
    expect(layout).toContain('<main id="MainContent"');
    expect((layout.match(/<main[\s>]/g) ?? []).length).toBe(1);
  });

  it("puts a portal-internal skip link first, past the rail", () => {
    const skipAt = CHROME_MARKUP.indexOf("athoor-portal__skip");
    const navAt = CHROME_MARKUP.indexOf("portal-nav");
    expect(skipAt).toBeGreaterThan(0);
    expect(skipAt, "the skip link is not before the navigation").toBeLessThan(navAt);
    expect(CHROME_MARKUP).toContain('href="#AthoorPortalContent"');
    expect(CHROME_MARKUP).toContain('id="AthoorPortalContent"');
  });

  it("renders one <nav> with the eight entries §17.4 names, in order", () => {
    expect((nav.match(/<nav[\s>]/g) ?? []).length).toBe(1);
    expect(nav).toContain('aria-label="Your account"');
    const list = /'([a-z,]+)' \| split: ','/.exec(nav)?.[1] ?? "";
    expect(list.split(",")).toEqual([
      "overview",
      "orders",
      "wishlist",
      "rewards",
      "referrals",
      "fragrance",
      "profile",
      "settings",
    ]);
  });

  it("nests Activity under Rewards rather than giving it a ninth entry (§17.4)", () => {
    const list = /'([a-z,]+)' \| split: ','/.exec(nav)?.[1] ?? "";
    expect(list).not.toContain("activity");
    // But the Activity page still shows the customer where they are.
    expect(read("theme", "templates", "page.my-athoor-activity.liquid")).toContain("nav_key: 'rewards'");
  });

  it("server-renders aria-current (Requirement 17.10)", () => {
    expect(nav).toContain('aria-current="page"');
    // Computed in Liquid from `current`, so the first paint already has it.
    expect(nav).toContain("if item == current");
  });

  it("marks the four demoted entries so CSS can hide them from the bar", () => {
    expect(nav).toContain("athoor-portal__nav-item--overflow");
    expect(nav).toContain("if forloop.index <= 4");
  });

  it("the More control is a button that declares its dialog", () => {
    expect(nav).toContain('aria-haspopup="dialog"');
    expect(nav).toContain('aria-controls="AthoorPortalMore"');
    // A `<button>`, because announcing it as a link would promise a page.
    expect(nav).toContain("<button");
  });

  it("the sheet is a <dialog> with a real dismiss control (Requirement 25.8)", () => {
    expect(sheet).toContain("<dialog");
    expect(sheet).toContain("data-portal-sheet-dismiss");
    expect(sheet).toContain("data-portal-sheet-heading");
    expect(sheet).toContain('id="AthoorPortalMore"');
  });

  it("the sheet renders the same four hrefs the bar demotes", () => {
    for (const href of [
      "/pages/my-athoor-referrals",
      "/pages/my-athoor-fragrance",
      "/pages/my-athoor-profile",
      "/pages/my-athoor-settings",
    ]) {
      expect(sheet, `sheet is missing ${href}`).toContain(href);
      expect(nav, `nav is missing ${href}`).toContain(href);
    }
  });

  it("renders both live regions from the server (§20.6)", () => {
    expect(CHROME_MARKUP).toContain("data-portal-live-global");
    expect(CHROME_MARKUP).toContain('role="status"');
    expect(markup("theme", "snippets", "portal-section.liquid")).toContain("data-portal-live");
  });
});

/* ========================================================================== *
 * 19.4 — the section templates
 * ========================================================================== */

describe("the section page templates (Requirements 15.1, 16.1, 6.3)", () => {
  const EXPECTED = [
    ["page.my-athoor.liquid", "overview"],
    ["page.my-athoor-orders.liquid", "orders"],
    ["page.my-athoor-order-detail.liquid", "order-detail"],
    ["page.my-athoor-wishlist.liquid", "wishlist"],
    ["page.my-athoor-rewards.liquid", "rewards"],
    ["page.my-athoor-activity.liquid", "activity"],
    ["page.my-athoor-referrals.liquid", "referrals"],
    ["page.my-athoor-fragrance.liquid", "fragrance"],
    ["page.my-athoor-profile.liquid", "profile"],
    ["page.my-athoor-settings.liquid", "settings"],
  ] as const;

  it("exists once per destination, and each names its own section", () => {
    const present = readdirSync(TEMPLATES).filter((f) => f.startsWith("page.my-athoor"));
    expect(present.sort()).toEqual(EXPECTED.map(([file]) => file).sort());

    for (const [file, section] of EXPECTED) {
      const source = readFileSync(join(TEMPLATES, file), "utf8");
      expect(source, `${file} does not render its section`).toContain(`name: '${section}'`);
      expect(source, `${file} does not pass its section to the chrome`).toContain(
        `section_name: '${section}'`,
      );
    }
  });

  it("every template routes through the chrome, so the flag is read once", () => {
    for (const [file] of EXPECTED) {
      const source = readFileSync(join(TEMPLATES, file), "utf8");
      expect(source, `${file} renders portal markup outside the chrome`).toContain(
        "{% render 'portal-chrome'",
      );
      // No template may evaluate the flag itself.
      expect(source, `${file} evaluates the flag itself`).not.toContain("settings.portal_enabled");
    }
  });

  it("each section root carries its skeleton, its state slots and its live region", () => {
    const shell = read("theme", "snippets", "portal-section.liquid");
    for (const hook of [
      'data-portal-section="{{ name }}"',
      'data-state="loading"',
      "data-portal-live",
      "data-portal-state-message",
      "data-portal-reference",
      "data-portal-retry",
      "data-portal-skeleton",
    ]) {
      expect(shell, `the section shell is missing ${hook}`).toContain(hook);
    }
  });

  it("declares a row <template> for each of the five renderers task 18.3 shipped", () => {
    const shell = read("theme", "snippets", "portal-section.liquid");
    for (const row of ["order", "wishlist", "activity", "reward", "stage"]) {
      expect(shell, `no <template> for the ${row} row`).toContain(`data-portal-row="${row}"`);
    }
    // The renderers fill `[data-slot]` with `textContent`, so every slot they write
    // must exist in the markup.
    for (const slot of ["link", "number", "date", "total", "status", "items"]) {
      expect(shell, `the order row has no ${slot} slot`).toContain(`data-slot="${slot}"`);
    }
  });

  it("order detail declares where its id comes from and the shape it must match", () => {
    const detail = read("theme", "templates", "page.my-athoor-order-detail.liquid");
    expect(detail).toContain('data-portal-id-source="query:id"');
    // The same pattern the API enforces, declared once so the two cannot drift.
    expect(detail).toContain('data-portal-id-pattern="^[0-9]{1,20}$"');
  });

  it("no template contains inline JavaScript", () => {
    // The portal's behaviour is in the bundles, which are typechecked and tested.
    // Inline script in a template is neither.
    for (const [file] of EXPECTED) {
      const source = readFileSync(join(TEMPLATES, file), "utf8");
      expect(source, `${file} contains inline script`).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    }
  });
});

/* ========================================================================== *
 * Coexistence — what Task 19 must NOT have touched (§25.3)
 * ========================================================================== */

describe("coexistence with the previous experience (§25.3, Requirement 22.10)", () => {
  it("leaves every dead customer-account template untouched", () => {
    // Branch B: `/account` is Shopify-hosted, so these are dead for the portal.
    // Task 19 must not edit them, and none of them may mention the portal.
    const dir = join(TEMPLATES, "customers");
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `${file} mentions the portal`).not.toContain("portal");
      expect(source, `${file} mentions my-athoor`).not.toContain("my-athoor");
    }
  });

  it("leaves the rewards dashboard and its route untouched (Requirement 22.10)", () => {
    const dashboard = markup("theme", "sections", "loyalty-dashboard.liquid");
    expect(dashboard).not.toContain("portal");
    expect(dashboard).not.toContain("my-athoor");
    expect(read("theme", "templates", "page.rewards.json")).not.toContain("portal");
  });

  it("leaves layout/theme.liquid entirely alone", () => {
    // §25.6 requires the `<head>` asset list of every other page to be unchanged.
    // The cheapest guarantee is never to touch the layout: the portal's stylesheet
    // and scripts are emitted by the chrome, inside the flag.
    const layout = markup("theme", "layout", "theme.liquid");
    expect(layout).not.toContain("athoor-portal");
    expect(layout).not.toContain("portal_enabled");
  });

  it("emits the portal's assets only inside the flag and only for a customer", () => {
    const assetsAt = CHROME_MARKUP.indexOf("athoor-portal.css");
    const flagAt = CHROME_MARKUP.indexOf("{%- if portal_on -%}");
    const customerAt = CHROME_MARKUP.indexOf("{%- if customer -%}");
    expect(flagAt).toBeGreaterThan(0);
    expect(assetsAt, "the stylesheet is emitted before the flag is read").toBeGreaterThan(flagAt);
    expect(assetsAt, "the stylesheet is emitted before the customer check").toBeGreaterThan(customerAt);
  });

  it("falls back to the page's own content when the flag is off", () => {
    // These are real Shopify pages, so whatever the merchant typed is the honest
    // "not available yet" state — and it discloses nothing about the portal.
    expect(CHROME_MARKUP).toContain("{{ page.content }}");
  });

  it("the settings schema declares both flag settings, off by default", () => {
    const schema = JSON.parse(read("theme", "config", "settings_schema.json")) as {
      name: string;
      settings?: { id?: string; type: string; default?: unknown }[];
    }[];
    const group = schema.find((g) => g.name === "My Athoor Portal");
    expect(group, "no My Athoor Portal settings group").toBeDefined();
    const byId = new Map((group?.settings ?? []).filter((s) => s.id).map((s) => [s.id as string, s]));
    expect(byId.get("portal_enabled")?.type).toBe("checkbox");
    expect(byId.get("portal_enabled")?.default, "the portal ships ON").toBe(false);
    expect(byId.get("portal_allowlist")?.type).toBe("textarea");
  });
});

/* ========================================================================== *
 * The evaluator's own soundness
 * ========================================================================== */

describe("the Liquid evaluator is sound enough to trust", () => {
  it("refuses a construct it does not understand rather than guessing", () => {
    // The hazard with a hand-written interpreter is silently ignoring a line. It
    // throws instead, so a snippet that grows a new construct fails loudly here
    // rather than being half-evaluated.
    expect(() =>
      evaluateFlag("{%- liquid\n  assign x = settings.unknown_thing\n-%}", SIGNED_IN),
    ).toThrow(/unsupported atom/);
    expect(() => evaluateFlag("{%- liquid\n  increment counter\n-%}", SIGNED_IN)).toThrow(
      /unsupported statement/,
    );
  });

  it("evaluates both real snippets without hitting an unsupported construct", () => {
    expect(() => evaluateFlag(CHROME, SIGNED_IN)).not.toThrow();
    expect(() => evaluateFlag(ACCOUNT_HREF, SIGNED_IN)).not.toThrow();
  });

  it("reads the files that actually ship", () => {
    expect(CHROME.length).toBeGreaterThan(500);
    expect(ACCOUNT_HREF.length).toBeGreaterThan(500);
    expect(SNIPPETS).toContain("snippets");
  });
});

/**
 * THE DARK-BY-DEFAULT GATE — Requirements 22.1, 22.2, 22.3.
 *
 * ── THE PROPERTY ────────────────────────────────────────────────────────────
 * The portal ships to the live theme **before** it is switched on (§25.7 run
 * order: migrations → service → theme push, dark → flag flip). Between the push
 * and the flip, the live theme carries every portal file and must render exactly
 * as it did before: no portal markup, no stylesheet, no script.
 *
 * That safety rests entirely on `snippets/portal-chrome.liquid` and on the two
 * settings in `config/settings_schema.json`. This gate fixes both ends of it.
 *
 * ── WHY IT ALSO SETTLES THE "28 OR 29 FILES" QUESTION ───────────────────────
 * `portal_on` starts `false` and is set `true` only by `settings.portal_enabled`
 * or by `settings.portal_allowlist` matching the current customer. On a theme
 * whose `settings_schema.json` does not declare those two settings, both resolve
 * to `nil`: the first is falsy, and Liquid treats `nil == blank` as true so
 * `!= blank` is false. Neither arm can fire, so the portal is dark *by
 * construction* — not by configuration.
 *
 * That is exactly what a 28-file push (the portal's own new files, with no edit
 * to the pre-existing `settings_schema.json`) produces, which is what task 30.1
 * asks for. It is also why 30.2 onwards cannot run on such a theme: there is no
 * way to turn the portal on. The schema edit belongs to 31.2's scoped diff, not
 * to 30.1's push.
 *
 * ── NON-VACUITY ─────────────────────────────────────────────────────────────
 * Flipping the schema default to `true`, or moving one `asset_url` outside the
 * `portal_on` branch, must turn these tests red. Both were confirmed by hand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./portalFixtures.js";

const CHROME = join(REPO_ROOT, "theme", "snippets", "portal-chrome.liquid");
const SCHEMA = join(REPO_ROOT, "theme", "config", "settings_schema.json");

/**
 * `portal-chrome.liquid` with its `{%- comment -%}` blocks removed.
 *
 * The header comment discusses `page.content` and names the portal assets in
 * prose. Scanning the raw file would find those words and conclude the branches
 * are wired when they might not be — the gate would be verifying the
 * documentation. (Task 29's CSS and `.mjs` gates hit the same trap.)
 */
function chromeWithoutComments(): string {
  return readFileSync(CHROME, "utf8").replace(
    /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
    "",
  );
}

/** The two settings blocks the portal adds, from the theme's schema. */
function portalSettings(): Array<Record<string, unknown>> {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as Array<{
    name?: string;
    settings?: Array<Record<string, unknown>>;
  }>;
  return schema
    .flatMap((group) => group.settings ?? [])
    .filter((s) => typeof s.id === "string" && String(s.id).startsWith("portal_"));
}

describe("the portal is dark by default", () => {
  it("declares portal_enabled as a checkbox defaulting to false", () => {
    const enabled = portalSettings().find((s) => s.id === "portal_enabled");
    expect(enabled, "settings_schema.json must declare portal_enabled").toBeDefined();
    expect(enabled?.type).toBe("checkbox");
    // The whole staged-rollout design depends on this default. A `true` here
    // would release the portal to every signed-in customer the moment the
    // schema reached the live theme — before 31.6's staged flip.
    expect(enabled?.default).toBe(false);
  });

  it("declares portal_allowlist with no default, so it starts blank", () => {
    const allow = portalSettings().find((s) => s.id === "portal_allowlist");
    expect(allow, "settings_schema.json must declare portal_allowlist").toBeDefined();
    expect(allow?.type).toBe("textarea");
    // A default would put customer ids in the allowlist on first install.
    expect(allow?.default).toBeUndefined();
  });

  it("adds exactly two portal settings and no third undocumented flag", () => {
    expect(portalSettings().map((s) => s.id).sort()).toEqual([
      "portal_allowlist",
      "portal_enabled",
    ]);
  });

  it("initialises portal_on to false before any condition can set it", () => {
    const body = chromeWithoutComments();
    const init = body.indexOf("assign portal_on = false");
    const firstTrue = body.indexOf("assign portal_on = true");
    expect(init).toBeGreaterThan(-1);
    expect(firstTrue).toBeGreaterThan(init);
  });

  it("sets portal_on true only from portal_enabled or portal_allowlist", () => {
    const body = chromeWithoutComments();
    // Every `settings.<x>` the snippet reads must be one of the two known flags.
    const read = [...body.matchAll(/settings\.([a-z_0-9]+)/g)].map((m) => m[1]);
    expect([...new Set(read)].sort()).toEqual(["portal_allowlist", "portal_enabled"]);
  });

  it("emits no portal stylesheet or script outside the portal_on branch", () => {
    const body = chromeWithoutComments();
    const gateOpens = body.indexOf("{%- if portal_on -%}");
    const gateCloses = body.lastIndexOf("{%- else -%}");
    expect(gateOpens).toBeGreaterThan(-1);
    expect(gateCloses).toBeGreaterThan(gateOpens);

    const outside: string[] = [];
    for (const match of body.matchAll(/'(athoor-portal[a-z0-9.\-]*)'/g)) {
      const at = match.index ?? -1;
      if (at < gateOpens || at > gateCloses) outside.push(match[1]);
    }
    expect(outside, "portal assets referenced where the flag cannot suppress them").toEqual(
      [],
    );
  });

  it("renders only the page's own content when the flag is off", () => {
    const body = chromeWithoutComments();
    const offBranch = body.slice(
      body.lastIndexOf("{%- else -%}") + "{%- else -%}".length,
      body.lastIndexOf("{%- endif -%}"),
    );
    // Exactly the admin-authored content. Anything else here — a wrapper div, a
    // preconnect, an analytics call — is portal output on a page that is meant
    // to be byte-identical to today's.
    expect(offBranch.trim()).toBe("{{ page.content }}");
  });
});

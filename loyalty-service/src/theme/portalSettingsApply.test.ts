/**
 * THE SETTINGS-SCHEMA TRANSFORM — the first thing here that edits a file a theme
 * already had.
 *
 * `config/settings_schema.json` is the merchant's entire admin-facing configuration
 * surface: every colour, font, layout and section option ever set. The portal needs
 * two settings appended to it. Replacing the file with the repository's copy would
 * silently discard live configuration, so `portal-settings-apply.mjs` parses the
 * remote copy and appends instead.
 *
 * That transform is pure, so it is tested here without a Shopify token — which
 * matters, because the alternative is discovering a defect while pointed at a
 * production theme.
 *
 * ── THE FIXTURE IS THE REAL FILE ────────────────────────────────────────────
 * The input is `theme/config/settings_schema.json` with the portal group removed,
 * so the round trip is exercised against 22 real setting groups rather than a
 * hand-written stub. Task 24 established why: a transcribed fixture cannot see a
 * change in the file that ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPortalGroup,
  setAllowlist,
} from "../../scripts/theme/portal-settings-apply.mjs";
import { REPO_ROOT } from "./portalFixtures.js";

const GROUP_NAME = "My Athoor Portal";

/** The shipped schema, and the same thing with the portal group taken back out. */
function fixtures() {
  const full = JSON.parse(
    readFileSync(join(REPO_ROOT, "theme", "config", "settings_schema.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  const group = full.find((g) => g.name === GROUP_NAME);
  expect(group, "the repository must declare the portal group").toBeDefined();
  const without = full.filter((g) => g.name !== GROUP_NAME);
  return { full, group: group as Record<string, unknown>, without };
}

describe("appendPortalGroup", () => {
  it("appends the group and preserves all 22 pre-existing groups exactly", () => {
    const { group, without } = fixtures();
    const result = appendPortalGroup(JSON.stringify(without, null, 2), group);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);

    const after = JSON.parse(result.text as string) as Array<Record<string, unknown>>;
    expect(after).toHaveLength(without.length + 1);
    // Byte-for-byte on every pre-existing element, in order. A group that survived
    // by name but lost one setting is the failure a count check would miss.
    for (let i = 0; i < without.length; i++) {
      expect(JSON.stringify(after[i]), `group ${i} must be untouched`).toBe(
        JSON.stringify(without[i]),
      );
    }
    expect(after[after.length - 1]).toEqual(group);
  });

  it("round-trips: stripping the group and re-appending restores the shipped file", () => {
    // The strongest available statement — the transform's output is the real file.
    const { full, group, without } = fixtures();
    const result = appendPortalGroup(JSON.stringify(without, null, 2), group);
    expect(JSON.parse((result as { text: string }).text)).toEqual(full);
  });

  it("refuses when the portal group is already present", () => {
    // Running twice must not append a duplicate, which would give the merchant two
    // identical setting groups and an ambiguous theme editor.
    const { full, group } = fixtures();
    const result = appendPortalGroup(JSON.stringify(full, null, 2), group);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already present/i);
  });

  it("refuses a schema that is not a top-level array", () => {
    const { group } = fixtures();
    expect(appendPortalGroup('{"not":"an array"}', group).ok).toBe(false);
    expect(appendPortalGroup('{"not":"an array"}', group).reason).toMatch(/array/i);
  });

  it("keeps the group's own contract: checkbox default false, textarea, no third setting", () => {
    const { group } = fixtures();
    const settings = (group.settings ?? []) as Array<Record<string, unknown>>;
    const byId = new Map(
      settings.filter((s) => typeof s.id === "string").map((s) => [s.id as string, s]),
    );
    expect([...byId.keys()].sort()).toEqual(["portal_allowlist", "portal_enabled"]);
    expect(byId.get("portal_enabled")?.type).toBe("checkbox");
    expect(byId.get("portal_enabled")?.default).toBe(false);
    expect(byId.get("portal_allowlist")?.type).toBe("textarea");
    expect(byId.get("portal_allowlist")?.default).toBeUndefined();
  });
});

describe("setAllowlist", () => {
  const base = JSON.stringify(
    { current: { colors_accent_1: "#b8960c", type_body_font: "assistant_n4", sections: {} } },
    null,
    2,
  );

  it("changes portal_allowlist and nothing else", () => {
    const result = setAllowlist(base, "9395357876563");
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    const after = JSON.parse(result.text as string);
    expect(after.current.portal_allowlist).toBe("9395357876563");
    // Every pre-existing key survives with its value.
    const before = JSON.parse(base);
    for (const key of Object.keys(before.current)) {
      expect(JSON.stringify(after.current[key]), `${key} must be untouched`).toBe(
        JSON.stringify(before.current[key]),
      );
    }
  });

  it("never writes portal_enabled, so the global switch cannot be flipped here", () => {
    // A staged rollout that also enabled the global flag would release the portal to
    // every signed-in customer — the opposite of what an allowlist is for.
    const after = JSON.parse((setAllowlist(base, "1") as { text: string }).text);
    expect("portal_enabled" in after.current).toBe(false);
  });

  it("refuses when current names a preset rather than holding values", () => {
    // Writing a scalar into a preset-named `current` would change which preset is
    // active, silently rewriting the whole theme configuration.
    const result = setAllowlist('{"current":"Default"}', "1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/preset/i);
  });

  it("refuses when portal_enabled is already truthy", () => {
    const result = setAllowlist(
      JSON.stringify({ current: { portal_enabled: true } }),
      "1",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/truthy/i);
  });

  it("refuses a settings_data with no current object", () => {
    expect(setAllowlist("{}", "1").ok).toBe(false);
  });
});

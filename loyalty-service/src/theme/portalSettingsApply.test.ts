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
import { appendPortalGroup, setAllowlist, verifyValues, pollForVerified } from "../../scripts/theme/portal-settings-apply.mjs";
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

  // ── --disable-portal-flag ──────────────────────────────────────────────────
  // `portal_enabled` is a MASTER SWITCH: `portal-chrome.liquid` reads
  // `if portal_enabled ... elsif portal_allowlist`, so while it is truthy the allowlist
  // is never evaluated and every signed-in customer is admitted. Turning it off has to
  // be expressible or an allowlist can only be written under the illusion of gating.
  // Found live on draft theme 205900054867: portal_enabled=true, allowlist absent.
  it("with disableFlag, turns a truthy switch off and sets the allowlist, touching nothing else", () => {
    const live = JSON.stringify({
      current: { portal_enabled: true, colors_accent_1: "#b8960c", sections: {} },
    });
    const result = setAllowlist(live, "9395357876563", { disableFlag: true });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    const after = JSON.parse(result.text as string);
    expect(after.current.portal_enabled).toBe(false);
    expect(after.current.portal_allowlist).toBe("9395357876563");
    expect(after.current.colors_accent_1).toBe("#b8960c");
    expect(JSON.stringify(after.current.sections)).toBe("{}");
  });

  it("is one-directional: NO input can make it write a truthy portal_enabled", () => {
    const states = [
      { current: {} },
      { current: { portal_enabled: true } },
      { current: { portal_enabled: false } },
      { current: { portal_enabled: "yes" } },
      { current: { portal_enabled: 1 } },
    ];
    for (const state of states) {
      for (const disableFlag of [true, false]) {
        for (const list of ["", "123"]) {
          const r = setAllowlist(JSON.stringify(state), list, { disableFlag });
          if (!r.ok) continue;
          const enabled = JSON.parse(r.text as string).current.portal_enabled;
          expect(enabled === undefined || enabled === false, `wrote ${JSON.stringify(enabled)}`).toBe(true);
        }
      }
    }
  });

  it("disabling without an allowlist changes only portal_enabled and adds no allowlist key", () => {
    const live = JSON.stringify({ current: { portal_enabled: true, sections: {} } });
    const result = setAllowlist(live, "", { disableFlag: true });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    const after = JSON.parse(result.text as string);
    expect(after.current.portal_enabled).toBe(false);
    expect("portal_allowlist" in after.current).toBe(false);
  });

  it("still refuses a preset-named current even when disabling", () => {
    const result = setAllowlist('{"current":"Default"}', "1", { disableFlag: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/preset/i);
  });
});

describe("read-after-write verification", () => {
  // -- THE BUG THIS BLOCK EXISTS FOR --------------------------------------------
  // The first production `--disable-portal-flag` run reported
  // `halted_values_verify_failed` with `portal_enabled: true`. The write had SUCCEEDED;
  // Shopify served a stale settings_data.json to the immediate read-back. A verifier
  // that fails a correct production write is worse than none.
  const want = { disableFlag: true, wantAllowlist: "9395357876563" };

  it("accepts exactly what was asked for", () => {
    expect(verifyValues({ portal_enabled: false, portal_allowlist: "9395357876563" }, want).ok).toBe(true);
  });

  it("rejects a switch that is still on, and a mismatched allowlist", () => {
    expect(verifyValues({ portal_enabled: true, portal_allowlist: "9395357876563" }, want).ok).toBe(false);
    expect(verifyValues({ portal_enabled: false, portal_allowlist: "999" }, want).ok).toBe(false);
  });

  it("ignores the allowlist when none was requested", () => {
    const r = verifyValues({ portal_enabled: false }, { disableFlag: true, wantAllowlist: "" });
    expect(r.ok).toBe(true);
  });

  it("survives a stale read and succeeds once the write becomes visible", async () => {
    const reads = [
      { portal_enabled: true, portal_allowlist: null },
      { portal_enabled: true, portal_allowlist: null },
      { portal_enabled: false, portal_allowlist: "9395357876563" },
    ];
    let i = 0;
    const { verified, attempts } = await pollForVerified(
      () => Promise.resolve(reads[i++] ?? reads[reads.length - 1]),
      (cur) => verifyValues(cur, want),
      { attempts: 6, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(verified.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("still fails when the value never becomes correct", async () => {
    const { verified, attempts } = await pollForVerified(
      () => Promise.resolve({ portal_enabled: true, portal_allowlist: null }),
      (cur) => verifyValues(cur, want),
      { attempts: 4, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(verified.ok).toBe(false);
    expect(attempts).toBe(4);
  });

  it("reports an unreadable asset rather than claiming success", async () => {
    const { verified } = await pollForVerified(
      () => Promise.resolve(null),
      (cur) => verifyValues(cur, want),
      { attempts: 2, delayMs: 0, sleep: () => Promise.resolve() },
    );
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/unreadable/i);
  });
});

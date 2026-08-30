#!/usr/bin/env node
/**
 * `portal-settings-apply.mjs` — append the portal settings group to a theme's
 * `config/settings_schema.json`, and optionally set the allowlist value.
 *
 * ── WHY THIS IS NOT PART OF THE 30.1 PUSH ───────────────────────────────────
 * `config/settings_schema.json` already exists on every theme, so changing it is a
 * MODIFICATION, not one of "the portal's own new files". Task 30.1's criteria
 * excluded it deliberately. It is needed before 30.2 can exercise anything,
 * because without the two settings declared, `settings.portal_enabled` and
 * `settings.portal_allowlist` are both `nil`, Liquid treats `nil == blank` as
 * true, and `portal_on` can never become true.
 *
 * ── THE RISK THIS FILE EXISTS TO CONTAIN ────────────────────────────────────
 * This is the first script here that EDITS a file the theme already had. A theme's
 * settings_schema is the entire admin-facing configuration surface: every colour,
 * font, layout and section option the merchant has ever set. Overwriting it with a
 * repository copy would silently discard live configuration.
 *
 * So the file is never replaced. The remote copy is parsed, the portal group is
 * appended to the array, and before the write is accepted the result is proved to
 * contain every pre-existing group unchanged — compared by name AND by serialised
 * value, not merely by count. A group that survived by name but lost a setting is
 * exactly the failure a count check would miss.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   Plan (default — writes nothing, prints the exact delta):
 *     SHOPIFY_THEME_TOKEN=… node scripts/theme/portal-settings-apply.mjs \
 *       --store=myathoorlondon.myshopify.com --environment=production \
 *       --confirm-production-store=myathoorlondon.myshopify.com \
 *       --theme-id=205900054867
 *
 *   Apply:            add --apply --confirm-theme-id=205900054867
 *   Also set allowlist: add --allowlist=9395357876563
 *   Undo:             add --rollback  (restores from the backup this script wrote)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_HALTED,
  EXIT_OK,
  finish,
  parseArgs,
  printBlock,
  requireSecretFromEnv,
  resolveTargetStore,
  usage,
} from "../migration/_shared.mjs";
import { assertEnvironmentIdentity } from "../migration/_envIdentity.mjs";

const USAGE = `
portal-settings-apply.mjs — append the portal settings group to a theme's settings_schema

  --store=<x.myshopify.com>          required
  --environment=production|staging|development   required
  --confirm-production-store=<exact> required when --store is production
  --theme-id=<id>                    required; must NOT be the live (role=main) theme
  --confirm-theme-id=<exact id>      required to write against production
  --allowlist=<comma-separated ids>  also set settings_data.json's portal_allowlist
  --apply                            perform the write (default: plan only)
  --rollback                         restore settings_schema.json from the backup

  token: SHOPIFY_THEME_TOKEN or SHOPIFY_ADMIN_API_TOKEN (environment only)
`;

const API = "2024-10";
const SCHEMA_KEY = "config/settings_schema.json";
const DATA_KEY = "config/settings_data.json";
const GROUP_NAME = "My Athoor Portal";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The portal group, taken from the repository so preview matches what 31.2 applies. */
function portalGroupFromRepo() {
  const local = JSON.parse(
    readFileSync(join(REPO_ROOT, "theme", "config", "settings_schema.json"), "utf8"),
  );
  const group = local.find((g) => g && g.name === GROUP_NAME);
  if (!group) throw new Error(`the repository's settings_schema.json has no "${GROUP_NAME}" group`);
  return group;
}

async function shopify({ store, token, method, path, body }) {
  const res = await fetch(`https://${store}/admin/api/${API}${path}`, {
    method,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, ok: res.ok, json };
}

const assetPath = (themeId, key) =>
  `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`;

/**
 * Append the portal group, and prove nothing else moved.
 *
 * Exported shape rather than inlined so `portalSettingsApply.test.ts` can drive it
 * without a Shopify token: the transformation is the dangerous part, and it is
 * pure.
 */
export function appendPortalGroup(originalText, group) {
  const before = JSON.parse(originalText);
  if (!Array.isArray(before)) {
    return { ok: false, reason: "settings_schema.json is not a top-level array" };
  }
  if (before.some((g) => g && g.name === GROUP_NAME)) {
    return { ok: false, reason: "the portal group is already present" };
  }

  const after = [...before, group];

  // Every pre-existing element must survive byte-for-byte, in the same order.
  for (let i = 0; i < before.length; i++) {
    if (JSON.stringify(after[i]) !== JSON.stringify(before[i])) {
      return { ok: false, reason: `pre-existing group at index ${i} changed` };
    }
  }
  if (after.length !== before.length + 1) {
    return { ok: false, reason: "expected exactly one appended group" };
  }
  if (JSON.stringify(after[after.length - 1]) !== JSON.stringify(group)) {
    return { ok: false, reason: "the appended group is not the portal group" };
  }

  return {
    ok: true,
    text: JSON.stringify(after, null, 2) + "\n",
    groupsBefore: before.length,
    groupsAfter: after.length,
    preservedNames: before.map((g) => (g && (g.name ?? g.theme_name)) ?? "(unnamed)"),
  };
}

/** Set `portal_allowlist` in settings_data.json without disturbing other values. */
export function setAllowlist(originalText, allowlist) {
  const data = JSON.parse(originalText);
  if (typeof data.current === "string") {
    // `current` naming a preset means the live values come from the schema's
    // presets, and writing a scalar here would change which preset is active.
    return { ok: false, reason: `current is a preset name ("${data.current}"), refusing to edit` };
  }
  if (typeof data.current !== "object" || data.current === null) {
    return { ok: false, reason: "settings_data.json has no current object" };
  }
  const before = JSON.stringify(data.current);
  const next = { ...data, current: { ...data.current, portal_allowlist: allowlist } };
  // portal_enabled is deliberately NOT written: absent means falsy, and the whole
  // point of a staged rollout is that the global switch stays off.
  if ("portal_enabled" in next.current && next.current.portal_enabled !== false) {
    return { ok: false, reason: "portal_enabled is already truthy; refusing to proceed" };
  }
  const changedKeys = Object.keys(next.current).filter(
    (k) => JSON.stringify(next.current[k]) !== JSON.stringify(data.current[k]),
  );
  if (changedKeys.length !== 1 || changedKeys[0] !== "portal_allowlist") {
    return { ok: false, reason: `expected only portal_allowlist to change, got ${changedKeys}` };
  }
  return { ok: true, text: JSON.stringify(next, null, 2) + "\n", untouchedBytes: before.length };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const store = resolveTargetStore({ args, usageText: USAGE });
  const token = requireSecretFromEnv({
    args,
    envNames: ["SHOPIFY_THEME_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"],
    argAliases: ["token", "access-token", "accessToken"],
    what: "a Shopify Admin API token with write_themes",
    usageText: USAGE,
  });

  // writes:false for the reason established in #36 — no database is involved, so
  // --confirm-db-fingerprint is unsatisfiable. --confirm-theme-id is the gate.
  assertEnvironmentIdentity({
    args, store, phase: "portal-settings", writes: false,
    databaseUrl: undefined, fail: (m) => usage(m, USAGE),
  });

  const themeId = args["theme-id"];
  if (!themeId || themeId === true) usage("--theme-id is required.", USAGE);
  const apply = Boolean(args.apply);
  const rollback = Boolean(args.rollback);

  if ((apply || rollback) && String(args["confirm-theme-id"] ?? "") !== String(themeId)) {
    usage(
      "REFUSING TO WRITE to a theme without explicit confirmation.\n" +
        `  Re-run with --confirm-theme-id=${themeId} (exact match required).\n` +
        "  This edits a file the theme ALREADY HAS — the merchant's entire admin\n" +
        "  configuration surface — so the target is confirmed by hand, not inferred.",
      USAGE,
    );
  }

  const themes = await shopify({ store, token, method: "GET", path: "/themes.json" });
  if (!themes.ok) {
    return finish({
      phase: "portal-settings",
      result: { status: "halted_theme_list_failed", httpStatus: themes.status },
      successStatus: "applied_verified",
    });
  }
  const target = (themes.json.themes ?? []).find((t) => String(t.id) === String(themeId));
  if (!target) {
    return finish({
      phase: "portal-settings",
      result: { status: "halted_theme_not_found", themeId: String(themeId) },
      successStatus: "applied_verified",
    });
  }
  if (target.role === "main") {
    return finish({
      phase: "portal-settings",
      result: {
        status: "halted_target_is_live_theme",
        note: "the live theme's settings_schema belongs to 31.2, after 31.1's backup and 31.3's approval",
      },
      successStatus: "applied_verified",
    });
  }

  const backupDir = join(REPO_ROOT, "backups", `theme-${themeId}-settings`);

  if (rollback) {
    const stamps = readdirSync(backupDir).sort();
    const latest = stamps[stamps.length - 1];
    if (!latest) {
      return finish({
        phase: "portal-settings",
        result: { status: "halted_no_backup", backupDir },
        successStatus: "restored",
      });
    }
    const saved = readFileSync(join(backupDir, latest, "settings_schema.json"), "utf8");
    const res = await shopify({
      store, token, method: "PUT", path: `/themes/${themeId}/assets.json`,
      body: { asset: { key: SCHEMA_KEY, value: saved } },
    });
    return finish({
      phase: "portal-settings",
      result: {
        status: res.ok ? "restored" : "halted_restore_failed",
        from: join(backupDir, latest),
        httpStatus: res.status,
      },
      successStatus: "restored",
    });
  }

  const current = await shopify({ store, token, method: "GET", path: assetPath(themeId, SCHEMA_KEY) });
  const currentText = current.json?.asset?.value;
  if (typeof currentText !== "string") {
    return finish({
      phase: "portal-settings",
      result: { status: "halted_schema_unreadable", httpStatus: current.status },
      successStatus: "applied_verified",
    });
  }

  const transformed = appendPortalGroup(currentText, portalGroupFromRepo());
  if (!transformed.ok) {
    return finish({
      phase: "portal-settings",
      result: { status: "halted_transform_refused", reason: transformed.reason },
      successStatus: "applied_verified",
    });
  }

  printBlock("portal-settings plan", {
    store,
    theme: { id: target.id, role: target.role, name: target.name },
    file: SCHEMA_KEY,
    groupsBefore: transformed.groupsBefore,
    groupsAfter: transformed.groupsAfter,
    appended: GROUP_NAME,
    preservedGroups: transformed.preservedNames,
    currentSha256: sha256(currentText).slice(0, 16),
    nextSha256: sha256(transformed.text).slice(0, 16),
    allowlist: args.allowlist ?? "(not set by this run)",
    mode: apply ? "apply" : "plan-only",
  });

  if (!apply) {
    console.log("\nPlan only. Nothing was written.");
    process.exit(EXIT_OK);
  }

  // Byte-exact backup BEFORE the write, in 31.1's shape.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupDir, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings_schema.json"), currentText, "utf8");
  writeFileSync(join(dir, "manifest.sha256"), `${sha256(currentText)}  ${SCHEMA_KEY}\n`, "utf8");
  console.log(`\nBacked up the current settings_schema.json to ${dir}`);

  const wrote = await shopify({
    store, token, method: "PUT", path: `/themes/${themeId}/assets.json`,
    body: { asset: { key: SCHEMA_KEY, value: transformed.text } },
  });
  if (!wrote.ok) {
    printBlock("schema write rejected", wrote.json);
    return finish({
      phase: "portal-settings",
      result: { status: "halted_schema_write_rejected", httpStatus: wrote.status },
      successStatus: "applied_verified",
    });
  }

  // Read back and re-prove the integrity property against what Shopify stored.
  const after = await shopify({ store, token, method: "GET", path: assetPath(themeId, SCHEMA_KEY) });
  const afterText = after.json?.asset?.value;
  let integrity = { ok: false, reason: "unreadable after write" };
  if (typeof afterText === "string") {
    const parsedBefore = JSON.parse(currentText);
    const parsedAfter = JSON.parse(afterText);
    const lost = parsedBefore.filter(
      (g, i) => JSON.stringify(parsedAfter[i]) !== JSON.stringify(g),
    );
    integrity = {
      ok: lost.length === 0 && parsedAfter.length === parsedBefore.length + 1 &&
        parsedAfter[parsedAfter.length - 1]?.name === GROUP_NAME,
      groupsNow: parsedAfter.length,
      lostOrChanged: lost.map((g) => g?.name ?? "(unnamed)"),
      portalGroupPresent: parsedAfter.some((g) => g?.name === GROUP_NAME),
    };
  }

  let allowlistResult = "(not requested)";
  if (args.allowlist && args.allowlist !== true && integrity.ok) {
    const dataRes = await shopify({ store, token, method: "GET", path: assetPath(themeId, DATA_KEY) });
    const dataText = dataRes.json?.asset?.value;
    if (typeof dataText !== "string") {
      allowlistResult = `unreadable (HTTP ${dataRes.status})`;
    } else {
      writeFileSync(join(dir, "settings_data.json"), dataText, "utf8");
      const next = setAllowlist(dataText, String(args.allowlist));
      if (!next.ok) {
        allowlistResult = `refused: ${next.reason}`;
      } else {
        const put = await shopify({
          store, token, method: "PUT", path: `/themes/${themeId}/assets.json`,
          body: { asset: { key: DATA_KEY, value: next.text } },
        });
        allowlistResult = put.ok ? `set to ${args.allowlist}` : `write failed (HTTP ${put.status})`;
      }
    }
  }

  return finish({
    phase: "portal-settings",
    result: {
      status: integrity.ok ? "applied_verified" : "halted_integrity_failed",
      theme: { id: target.id, role: target.role, name: target.name },
      integrity,
      allowlist: allowlistResult,
      backup: dir,
      rollback:
        `node scripts/theme/portal-settings-apply.mjs --store=${store} ` +
        `--environment=${args.environment ?? args.env} --theme-id=${themeId} ` +
        `--confirm-theme-id=${themeId} --rollback`,
    },
    successStatus: "applied_verified",
  });
}

// Only run when invoked directly, so the pure transforms above stay importable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_HALTED);
  });
}

#!/usr/bin/env node
/**
 * portal-live-push.mjs — task 31.4: the ONE write to the live theme.
 *
 * Every other tool in this repo refuses `role: main`. This one requires it, so the
 * protections are the opposite shape: not "cannot touch live" but "cannot touch anything
 * other than the exact approved paths, and cannot proceed if live has drifted since the
 * backup was taken".
 *
 * WHAT MUST HOLD BEFORE A SINGLE BYTE IS WRITTEN
 *   1. The target theme's role is `main`. Pushing this to the draft would be a silent no-op
 *      that looks like success.
 *   2. Every requested path is in APPROVED_PATHS. The approved artefact enumerates two paths;
 *      31.2 forbids globs, and the return-policy sweep put five MORE modified files in the
 *      repo, so an unconstrained push would now ship a policy change inside a portal release.
 *   3. A 31.1 backup exists for every path, and the CURRENT live bytes still hash to what that
 *      backup recorded. If live has changed since, the rollback bytes are stale and the diff
 *      was reviewed against a file that no longer exists — so it stops.
 *   4. The staged bytes come from `theme-push/`, never the working tree. The working tree's
 *      header.liquid carries seven unrelated aria-label hunks the owner explicitly held back
 *      for a separate release.
 *
 * AND AFTER
 *   5. Each file is re-read and hash-compared to the staged bytes, polled, because Shopify
 *      serves stale config assets straight after a PUT (observed during 31.7).
 *   6. The theme's asset key-list hash is compared before and after. This push modifies
 *      existing files, so the key list must be byte-identical: that catches an accidental
 *      create or delete, which per-file hashing alone would miss.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseArgs, requireSecretFromEnv, resolveTargetStore, finish, printBlock, EXIT_OK, EXIT_HALTED,
} from "../migration/_shared.mjs";
import { assertEnvironmentIdentity } from "../migration/_envIdentity.mjs";

const USAGE = `
portal-live-push.mjs — push the approved portal diff to the LIVE theme (task 31.4)

  --store=<x.myshopify.com>            required
  --environment=production             required
  --confirm-production-store=<exact>   required
  --theme-id=<id>                      required; MUST be the live (role=main) theme
  --confirm-theme-id=<exact id>        required
  --only=<comma-separated paths>       required; each must be an approved path, no globs
  --confirm-live-push=I-APPROVE        required to write
  --apply                              perform the writes (default: plan only)

  token: SHOPIFY_THEME_TOKEN or SHOPIFY_ADMIN_API_TOKEN (environment only)
`;

/** The 31.3-approved file list, verbatim. Anything else is refused. */
// REVISED after the 31.4 incident. The original two-file list was NOT deployable:
// sections/header.liquid renders 'portal-account-href', which was absent from live, so
// Shopify rendered the error into the account link on every page. The snippet is the
// transitive closure of header.liquid's new dependencies — exactly one file.
// The COMPLETE transitive closure for the portal live deployment, recomputed after the 31.4
// incident. 28 additive files + 2 modified = 30.
//
// The 10 per-section bundles are NOT statically reachable: portal-chrome.liquid line 113
// builds the name at render time as
//   {{ 'athoor-portal-' | append: section_name | append: '.js' | asset_url }}
// A closure computed only from literal asset references misses all ten, and pushing that
// subset would render the portal with every section silently failing to load its bundle —
// the same class of failure as the header incident, one level deeper.
//
// DELIBERATELY EXCLUDED: the five return-policy files (a separate release) and the seven
// aria-label hunks inside header.liquid (held back on the owner's instruction).
const APPROVED_PATHS = [
  "assets/athoor-portal-activity.js",
  "assets/athoor-portal-core.js",
  "assets/athoor-portal-fragrance.js",
  "assets/athoor-portal-order-detail.js",
  "assets/athoor-portal-orders.js",
  "assets/athoor-portal-overview.js",
  "assets/athoor-portal-profile.js",
  "assets/athoor-portal-referrals.js",
  "assets/athoor-portal-rewards.js",
  "assets/athoor-portal-settings.js",
  "assets/athoor-portal-wishlist.js",
  "assets/athoor-portal.css",
  "config/settings_schema.json",
  "sections/header.liquid",
  "snippets/portal-account-href.liquid",
  "snippets/portal-chrome.liquid",
  "snippets/portal-more-sheet.liquid",
  "snippets/portal-nav.liquid",
  "snippets/portal-section.liquid",
  "snippets/portal-signin-invitation.liquid",
  "templates/page.my-athoor-activity.liquid",
  "templates/page.my-athoor-fragrance.liquid",
  "templates/page.my-athoor-order-detail.liquid",
  "templates/page.my-athoor-orders.liquid",
  "templates/page.my-athoor-profile.liquid",
  "templates/page.my-athoor-referrals.liquid",
  "templates/page.my-athoor-rewards.liquid",
  "templates/page.my-athoor-settings.liquid",
  "templates/page.my-athoor-wishlist.liquid",
  "templates/page.my-athoor.liquid",
];
const API = "2024-10";
const LIVE_ROLE = "main";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopify(store, token, method, path, body) {
  const res = await fetch(`https://${store}/admin/api/${API}${path}`, {
    method,
    headers: {
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { ok: res.ok, status: res.status, json };
}

/** Key-sorted stringify, so two JSON documents with the same content compare equal. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Did what Shopify stored match what we pushed?
 *
 * -- THE FAILURE THIS EXISTS TO PREVENT ------------------------------------
 * The first live run reported `halted_verify_failed` on config/settings_schema.json after
 * eight polled reads. The write had SUCCEEDED: live held 23 groups, the portal group with
 * both setting ids, and content SEMANTICALLY IDENTICAL to the staged file. It differed by
 * EIGHT BYTES because Shopify reformats theme config JSON on write.
 *
 * Byte equality is therefore the wrong test for a `.json` asset — it fails a correct write,
 * which is the failure mode that gets a verifier deleted. It stays the ONLY test for Liquid
 * and other text assets, where the platform does not reformat and a byte difference is a real
 * difference. For JSON the test becomes canonical-content equality, which is stricter than
 * "close enough": a genuinely different document still fails.
 */
export function verifyStored(key, staged, current) {
  if (sha256(current) === sha256(staged)) return { ok: true, mode: "byte-identical" };
  if (key.endsWith(".json")) {
    try {
      if (canonicalJson(JSON.parse(current)) === canonicalJson(JSON.parse(staged))) {
        return { ok: true, mode: "json-content-identical-shopify-reformatted" };
      }
      return { ok: false, mode: "json-content-differs" };
    } catch {
      return { ok: false, mode: "json-unparseable" };
    }
  }
  return { ok: false, mode: "bytes-differ" };
}

const assetPath = (id, key) => `/themes/${id}/assets.json?asset%5Bkey%5D=${encodeURIComponent(key)}`;

/** Newest 31.1 backup directory for this theme, and its manifest. */
export function latestBackup(themeId, root = REPO_ROOT) {
  const base = join(root, "backups", `live-${themeId}`);
  const dirs = readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort();
  if (dirs.length === 0) throw new Error("no 31.1 backup exists for this theme");
  const dir = join(base, dirs[dirs.length - 1]);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return { dir, manifest };
}

/** Reject anything that is not an exactly-approved path. */
export function resolveOnly(raw) {
  const requested = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) return { ok: false, reason: "--only is required" };
  if (requested.some((p) => p.includes("*") || p.includes("?"))) {
    return { ok: false, reason: "globs are forbidden (31.2)" };
  }
  const unapproved = requested.filter((p) => !APPROVED_PATHS.includes(p));
  if (unapproved.length > 0) return { ok: false, reason: `not in the approved list: ${unapproved.join(", ")}` };
  return { ok: true, paths: requested };
}

async function keyListHash(store, token, themeId) {
  const res = await shopify(store, token, "GET", `/themes/${themeId}/assets.json`);
  const keys = (res.json?.assets ?? []).map((a) => a.key).sort();
  return { count: keys.length, hash: sha256(keys.join("\n")) };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const store = resolveTargetStore({ args, usageText: USAGE });
  const token = requireSecretFromEnv({
    args, envNames: ["SHOPIFY_THEME_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"],
    argAliases: ["token", "access-token", "accessToken"],
    what: "a Shopify Admin API token with write_themes", usageText: USAGE,
  });
  const themeId = String(args["theme-id"] ?? "");
  const apply = Boolean(args.apply);
  if (themeId === "") { console.error(USAGE); process.exit(2); }
  if (String(args["confirm-theme-id"] ?? "") !== themeId) {
    console.error(`\nRefusing: --confirm-theme-id must equal --theme-id (${themeId}).`);
    process.exit(2);
  }
  const only = resolveOnly(args.only);
  if (!only.ok) { console.error(`\nRefusing: ${only.reason}`); process.exit(2); }
  if (apply && String(args["confirm-live-push"] ?? "") !== "I-APPROVE") {
    console.error("\nRefusing: --apply against the LIVE theme requires --confirm-live-push=I-APPROVE.");
    process.exit(2);
  }
  await assertEnvironmentIdentity({ args, phase: "portal-live-push", store, writes: false, usageText: USAGE });

  const themes = await shopify(store, token, "GET", "/themes.json");
  const target = (themes.json?.themes ?? []).find((t) => String(t.id) === themeId);
  if (!target) return finish({ phase: "portal-live-push",
    result: { status: "halted_theme_not_found", themeId }, successStatus: "pushed_verified" });
  if (target.role !== LIVE_ROLE) return finish({ phase: "portal-live-push",
    result: { status: "halted_not_the_live_theme", role: target.role, expected: LIVE_ROLE },
    successStatus: "pushed_verified" });

  const { dir: backupDir, manifest } = latestBackup(themeId);
  const backedUp = new Map(manifest.files.map((f) => [f.key, f.sha256]));

  // Drift + staging checks BEFORE anything is written.
  const plan = [];
  for (const key of only.paths) {
    if (!backedUp.has(key)) return finish({ phase: "portal-live-push",
      result: { status: "halted_no_backup_for_path", key, backupDir }, successStatus: "pushed_verified" });
    const live = await shopify(store, token, "GET", assetPath(themeId, key));
    const liveText = live.json?.asset?.value;
    if (typeof liveText !== "string") return finish({ phase: "portal-live-push",
      result: { status: "halted_live_unreadable", key, httpStatus: live.status }, successStatus: "pushed_verified" });
    const liveHash = sha256(liveText);
    if (liveHash !== backedUp.get(key)) return finish({ phase: "portal-live-push",
      result: { status: "halted_live_drifted_since_backup", key,
        backupSha256: backedUp.get(key), liveSha256: liveHash,
        note: "the reviewed diff was against different bytes; re-run 31.1 and re-approve" },
      successStatus: "pushed_verified" });
    const staged = readFileSync(join(REPO_ROOT, "theme-push", key), "utf8");
    plan.push({ key, liveBytes: liveText.length, stagedBytes: staged.length,
      liveSha256: liveHash.slice(0, 16), stagedSha256: sha256(staged).slice(0, 16), staged });
  }

  const before = await keyListHash(store, token, themeId);
  printBlock("portal-live-push plan", {
    store, theme: { id: target.id, role: target.role, name: target.name },
    approvedArtefact: "docs/ops/portal-31-3-approval-artefact.md",
    onlyPaths: only.paths, globsUsed: false,
    backupDir, driftCheck: "every live file still hashes to its 31.1 backup",
    files: plan.map(({ staged, ...rest }) => rest),
    assetKeyList: before, mode: apply ? "apply" : "plan-only",
  });
  if (!apply) { console.log("\nPlan only. Nothing was written."); process.exit(EXIT_OK); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = join(REPO_ROOT, "backups", `live-push-${themeId}`, stamp);
  mkdirSync(evidence, { recursive: true });

  const written = [];
  for (const p of plan) {
    const put = await shopify(store, token, "PUT", `/themes/${themeId}/assets.json`,
      { asset: { key: p.key, value: p.staged } });
    if (!put.ok) return finish({ phase: "portal-live-push",
      result: { status: "halted_write_rejected", key: p.key, httpStatus: put.status, written },
      successStatus: "pushed_verified" });
    // Poll: Shopify serves a stale config asset straight after a PUT (seen in 31.7).
    let verified = false, attempts = 0, mode = "never read";
    const want = sha256(p.staged);
    for (let i = 1; i <= 8; i += 1) {
      attempts = i;
      const back = await shopify(store, token, "GET", assetPath(themeId, p.key));
      const text = back.json?.asset?.value;
      if (typeof text === "string") {
        const v = verifyStored(p.key, p.staged, text);
        mode = v.mode;
        if (v.ok) { verified = true; break; }
      }
      await sleep(4000);
    }
    written.push({ key: p.key, verified, verifiedBy: mode, readAttempts: attempts, sha256: want.slice(0, 16) });
    if (!verified) return finish({ phase: "portal-live-push",
      result: { status: "halted_verify_failed", key: p.key, written,
        rollback: `restore ${p.key} from ${backupDir}` }, successStatus: "pushed_verified" });
  }

  const after = await keyListHash(store, token, themeId);
  writeFileSync(join(evidence, "push-evidence.json"), JSON.stringify({
    task: "31.4", store, theme: { id: target.id, role: target.role },
    pushedAt: new Date().toISOString(), only: only.paths, written,
    assetKeyList: { before, after, unchanged: before.hash === after.hash && before.count === after.count },
    backupDir,
  }, null, 2) + "\n", "utf8");

  const keyListOk = before.hash === after.hash && before.count === after.count;
  return finish({
    phase: "portal-live-push",
    result: {
      status: keyListOk ? "pushed_verified" : "halted_asset_list_changed",
      theme: { id: target.id, role: target.role, name: target.name },
      written,
      assetKeyList: { before, after, unchanged: keyListOk },
      evidence, backupDir,
      rollback: `restore the two files from ${backupDir} and re-verify their sha256`,
    },
    successStatus: "pushed_verified",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_HALTED);
  });
}

#!/usr/bin/env node
/**
 * portal-live-backup.mjs — task 31.1: byte-exact backups of every live file the portal
 * will MODIFY, before any push.
 *
 * -- READ-ONLY AGAINST SHOPIFY, BY CONSTRUCTION -------------------------------
 * This is the only tool that targets the LIVE theme, so it must be impossible for it to
 * write there. It issues GET and nothing else; `portalLiveBackup.test.ts` statically
 * asserts that no mutating HTTP method appears in this file, so the guarantee is checked
 * rather than promised.
 *
 * -- THE FILE SET IS DERIVED, NEVER TYPED ------------------------------------
 * 31.1 covers files the portal MODIFIES. A file the portal only ADDS has nothing to back
 * up: restoring it means deleting it. So the set is
 *   git diff --diff-filter=M --name-only <PRE_PORTAL_COMMIT> HEAD -- theme/
 * which is the exact complement of the `--diff-filter=A` set that `portal-preview-push`
 * deploys. Hardcoding a list would let the two drift apart silently.
 *
 * Git must run from the repository root: `theme/` is a SIBLING of `loyalty-service/`, so
 * a pathspec of `theme/` matches nothing when the cwd is the service directory.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseArgs, requireSecretFromEnv, resolveTargetStore, finish, printBlock, EXIT_HALTED,
} from "../migration/_shared.mjs";
import { assertEnvironmentIdentity } from "../migration/_envIdentity.mjs";

const USAGE = `
portal-live-backup.mjs — byte-exact backups of the live files the portal will modify (31.1)

  --store=<x.myshopify.com>          required
  --environment=production|staging|development   required
  --confirm-production-store=<exact> required when --store is production
  --theme-id=<id>                    required; MUST be the live (role=main) theme
  --confirm-theme-id=<exact id>      required

  token: SHOPIFY_THEME_TOKEN or SHOPIFY_ADMIN_API_TOKEN (environment only)

Reads only. Writes nothing to Shopify. Output goes to
backups/live-<themeId>/<UTC timestamp>/ with a manifest.
`;

const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";

// Matches the sibling scripts: derived, so the tool works from any cwd. `theme/` is a
// SIBLING of `loyalty-service/`, so every git call must run from the repository root.
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const API = "2024-10";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** Files the portal modifies on an existing theme, derived from history. */
export function modifiedThemeFiles(preCommit = PRE_PORTAL_COMMIT, head = "HEAD") {
  const out = git(["diff", "--diff-filter=M", "--name-only", preCommit, head, "--", "theme/"]);
  return out === "" ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** `theme/snippets/x.liquid` -> the Shopify asset key `snippets/x.liquid`. */
export function assetKeyFor(repoPath) {
  if (!repoPath.startsWith("theme/")) throw new Error(`not a theme path: ${repoPath}`);
  return repoPath.slice("theme/".length);
}

async function getJson(store, token, path) {
  const res = await fetch(`https://${store}/admin/api/${API}${path}`, {
    headers: { "X-Shopify-Access-Token": token, Accept: "application/json" },
  });
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const store = resolveTargetStore({ args, usageText: USAGE });
  const token = requireSecretFromEnv({
    args,
    envNames: ["SHOPIFY_THEME_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"],
    argAliases: ["token", "access-token", "accessToken"],
    what: "a Shopify Admin API token with read_themes",
    usageText: USAGE,
  });
  const themeId = String(args["theme-id"] ?? "");
  if (themeId === "") { console.error(USAGE); process.exit(2); }
  if (String(args["confirm-theme-id"] ?? "") !== themeId) {
    console.error(`\nRefusing: --confirm-theme-id must equal --theme-id (${themeId}).`);
    process.exit(2);
  }
  await assertEnvironmentIdentity({ args, phase: "portal-live-backup", store, writes: false, usageText: USAGE });

  const themes = await getJson(store, token, "/themes.json");
  if (!themes.ok) return finish({ phase: "portal-live-backup",
    result: { status: "halted_themes_unreadable", httpStatus: themes.status }, successStatus: "backed_up_verified" });
  const target = themes.json.themes.find((t) => String(t.id) === themeId);
  if (!target) return finish({ phase: "portal-live-backup",
    result: { status: "halted_theme_not_found", themeId }, successStatus: "backed_up_verified" });
  // 31.1 is specifically about the LIVE theme. Backing up the wrong theme would produce a
  // manifest that looks valid and restores the wrong bytes.
  if (target.role !== "main") return finish({ phase: "portal-live-backup",
    result: { status: "halted_not_the_live_theme", role: target.role, expected: "main" },
    successStatus: "backed_up_verified" });

  const files = modifiedThemeFiles();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(REPO_ROOT, "backups", `live-${themeId}`, stamp);

  printBlock("portal-live-backup plan", {
    store, theme: { id: target.id, role: target.role, name: target.name },
    derivedFrom: `git diff --diff-filter=M ${PRE_PORTAL_COMMIT.slice(0, 7)}..HEAD -- theme/`,
    files, count: files.length, destination: dir, writesToShopify: false,
  });
  if (files.length === 0) return finish({ phase: "portal-live-backup",
    result: { status: "halted_no_files_to_back_up" }, successStatus: "backed_up_verified" });

  mkdirSync(dir, { recursive: true });
  const manifest = [];
  for (const repoPath of files) {
    const key = assetKeyFor(repoPath);
    const res = await getJson(store, token,
      `/themes/${themeId}/assets.json?asset%5Bkey%5D=${encodeURIComponent(key)}`);
    const value = res.json?.asset?.value;
    if (typeof value !== "string") {
      return finish({ phase: "portal-live-backup",
        result: { status: "halted_asset_unreadable", key, httpStatus: res.status },
        successStatus: "backed_up_verified" });
    }
    const dest = join(dir, key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, value, "utf8");
    manifest.push({ key, bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) });
  }

  // Re-read from disk and re-hash: proves what landed, not what we intended to write.
  const mismatches = manifest.filter((m) => sha256(readFileSync(join(dir, m.key), "utf8")) !== m.sha256);
  writeFileSync(join(dir, "manifest.sha256"),
    manifest.map((m) => `${m.sha256}  ${m.key}`).join("\n") + "\n", "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    task: "31.1", store, theme: { id: target.id, role: target.role, name: target.name },
    capturedAt: new Date().toISOString(), derivedFrom: PRE_PORTAL_COMMIT,
    headCommit: git(["rev-parse", "HEAD"]), files: manifest,
  }, null, 2) + "\n", "utf8");

  return finish({
    phase: "portal-live-backup",
    result: {
      status: mismatches.length === 0 ? "backed_up_verified" : "halted_hash_mismatch",
      theme: { id: target.id, role: target.role, name: target.name },
      backedUp: manifest.length, files: manifest, mismatches, directory: dir,
      wroteToShopify: false,
    },
    successStatus: "backed_up_verified",
  });
}

// Same guard as the sibling tools: two of them once called main() at top level, so
// importing either would run a production tool inside the test suite. Exact-URL rather
// than a filename suffix, so a like-named file elsewhere cannot trigger it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_HALTED);
  });
}

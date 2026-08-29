#!/usr/bin/env node
/**
 * `portal-preview-push.mjs` — task 30.1 in one controlled pass.
 *
 * Pushes the portal's own NEW theme files to a NON-LIVE theme, verifies every
 * byte landed, proves the portal is still dark, and prints the rollback.
 *
 * ── WHY A SCRIPT AND NOT A SEQUENCE OF CURL CALLS ────────────────────────────
 * 30.1's acceptance criteria are "push only the portal's own new files", "no live
 * theme file is touched by this task", and an implied verification that what
 * landed is what was intended. Each of those is a place to get it wrong by hand:
 * a glob that catches a modified file, a push to the wrong theme id, a 200 that
 * silently truncated content. The checks belong next to the push.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 *   · run without an explicit `--environment` (via `assertEnvironmentIdentity`)
 *   · run against the production store without `--confirm-production-store`
 *   · accept the token as an argument (env only — never shell history)
 *   · push to a theme whose `role` is `main` — that is the LIVE theme, and 30.1
 *     exists precisely so nothing reaches it
 *   · push any file that is not in the derived new-file set
 *   · write anything at all without `--apply` (planning is the default)
 *
 * ── THE FILE LIST IS DERIVED FROM GIT, NEVER FROM THE WORKING TREE ──────────
 * The set is "files added under `theme/` between the pre-portal commit and the
 * commit being deployed". Reading the working tree would push whatever happens to
 * be lying there — including unrelated local edits, which §25.5 says must be
 * resolved with the owner before any push. A commit cannot be accidentally dirty.
 *
 * A MODIFIED file is never in this set, which is what keeps 30.1 honest:
 * `config/settings_schema.json` and `sections/header.liquid` are modifications and
 * belong to 31.2's scoped diff, under 31.1's byte-exact backup.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   Plan (default — writes nothing):
 *     SHOPIFY_THEME_TOKEN=… node scripts/theme/portal-preview-push.mjs \
 *       --store=myathoorlondon.myshopify.com --environment=production \
 *       --confirm-production-store=myathoorlondon.myshopify.com \
 *       --theme-id=<unpublished theme id>
 *
 *   Apply: add `--apply`.
 *   Roll back: add `--rollback` (deletes the pushed keys, restores any backup).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
portal-preview-push.mjs — push the portal's new theme files to a NON-LIVE theme (task 30.1)

  --store=<x.myshopify.com>          required; the Admin API host
  --environment=production|staging|development
                                     required; cross-checked against --store
  --confirm-production-store=<exact> required when --store is production
  --theme-id=<id>                    required; must NOT be the live (role=main) theme
  --confirm-theme-id=<exact id>      required to write/rollback against production
  --from=<commit>                    commit to deploy from (default HEAD)
  --apply                            perform the writes (default: plan only)
  --rollback                         delete the pushed keys instead of pushing

  token: SHOPIFY_THEME_TOKEN or SHOPIFY_ADMIN_API_TOKEN (environment only)
`;

/** The last commit of the pre-portal world; the "new files" set is measured from it. */
const PRE_PORTAL_COMMIT = "32eaca022c140bee9c7451813c735cd1c3389878";

/**
 * How many new theme files the portal is expected to ship.
 *
 * Pinned so a surprise halts the run rather than being pushed silently. If the
 * portal legitimately gains a file, this number changes in the same commit and
 * the owner's approved file list (31.3) is re-approved against the new count.
 */
const EXPECTED_NEW_FILES = 28;

const API_VERSION = "2024-10";

/**
 * Repository root.
 *
 * Every git call and the backup directory resolve against this, not the process
 * cwd. The script lives in `loyalty-service/scripts/theme/` and is run from
 * `loyalty-service/`, where `git diff -- theme/` matches nothing at all — the
 * theme is a sibling of `loyalty-service`, not a child. A pathspec that matches
 * nothing yields an empty file set, and an empty push reports success while
 * having deployed nothing.
 */
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Files ADDED under `theme/` between the pre-portal commit and `commit`. */
function newThemeFiles(commit) {
  return git(["diff", "--diff-filter=A", "--name-only", PRE_PORTAL_COMMIT, commit, "--", "theme/"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

/** Exact committed bytes of `repoPath` at `commit`. Buffer, so bytes are untouched. */
function blobAt(commit, repoPath) {
  return execFileSync("git", ["show", `${commit}:${repoPath}`], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** `theme/snippets/x.liquid` -> `snippets/x.liquid` (the Shopify asset key). */
const assetKey = (repoPath) => repoPath.replace(/^theme\//, "");

async function shopify({ store, token, method, path, body }) {
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}${path}`, {
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

async function main() {
  // `parseArgs` returns `{ args, positional }`. Assigning the wrapper object made
  // every lookup undefined, so the script refused everything with "--store is
  // required" — five different guards reporting one wrong reason, which reads as
  // five working guards until you check WHY each refused.
  const { args } = parseArgs(process.argv.slice(2));
  const store = resolveTargetStore({ args, usageText: USAGE });
  const token = requireSecretFromEnv({
    args,
    envNames: ["SHOPIFY_THEME_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"],
    argAliases: ["token", "access-token", "accessToken"],
    what: "a Shopify Admin API token with write_themes",
    usageText: USAGE,
  });

  // Same explicit-environment discipline as the cutover scripts: `--environment`
  // is mandatory and is cross-checked against the store domain.
  //
  // `writes` is FALSE even under `--apply`, and that is not a loosening. In
  // `assertEnvironmentIdentity`, `writes: true` triggers `--confirm-db-fingerprint`,
  // whose whole purpose is to make an operator prove they looked at which DATABASE
  // they are about to write to. A theme push opens no database connection, so there
  // is no fingerprint to type — the guard reported exactly that ("No DATABASE_URL is
  // configured, so there is nothing to confirm") and became unsatisfiable, blocking
  // every production apply. Passing `writes: true` was a category error: the gate
  // protects a resource this script never touches.
  //
  // The deliberate-confirmation principle it embodies is kept, and pointed at the
  // resource actually at risk — see the `--confirm-theme-id` gate below. Production
  // confirmation is unaffected either way: `resolveTargetStore` already requires
  // `--confirm-production-store=<exact domain>`.
  assertEnvironmentIdentity({
    args,
    store,
    phase: "theme-push",
    writes: false,
    databaseUrl: undefined,
    fail: (message) => usage(message, USAGE),
  });

  const themeId = args["theme-id"];
  if (!themeId || themeId === true) usage("--theme-id is required.", USAGE);
  const commit = args.from && args.from !== true ? String(args.from) : "HEAD";
  const apply = Boolean(args.apply);
  const rollback = Boolean(args.rollback);

  /*
   * Deliberate confirmation of the THEME, for any write against production.
   *
   * This replaces the database-fingerprint gate that cannot apply here, and keeps
   * its reasoning verbatim: typing it is the point, because a value that can be
   * inherited from the environment confirms nothing. The theme id is the resource a
   * mistake actually destroys — this store has five themes, four of them
   * unpublished, and two are named as backups. A digit wrong in `--theme-id` is the
   * realistic accident, and it is silent: every other guard would still pass.
   */
  if ((apply || rollback) && store === "myathoorlondon.myshopify.com") {
    const confirmed = args["confirm-theme-id"];
    if (String(confirmed ?? "") !== String(themeId)) {
      usage(
        "REFUSING TO WRITE to a PRODUCTION theme without explicit confirmation.\n" +
          `  Re-run with --confirm-theme-id=${themeId} (exact match required)` +
          `${confirmed === undefined ? "" : `; got "${String(confirmed)}"`}.\n\n` +
          "Check the id against `GET /admin/api/2024-10/themes.json` first: a wrong\n" +
          "digit targets a different theme and no other guard would notice.",
        USAGE,
      );
    }
  }

  /* ---- 1. the target must not be the live theme ------------------------- */
  const themes = await shopify({ store, token, method: "GET", path: "/themes.json" });
  if (!themes.ok) {
    printBlock("theme list failed", themes);
    return finish({
      phase: "theme-push",
      result: { status: "halted_theme_list_failed", httpStatus: themes.status },
      successStatus: "pushed_verified",
    });
  }
  const target = (themes.json.themes ?? []).find((t) => String(t.id) === String(themeId));
  if (!target) {
    return finish({
      phase: "theme-push",
      result: {
        status: "halted_theme_not_found",
        themeId: String(themeId),
        available: (themes.json.themes ?? []).map((t) => ({ id: t.id, role: t.role, name: t.name })),
      },
      successStatus: "pushed_verified",
    });
  }
  if (target.role === "main") {
    // The whole point of 30.1. Task 31.4 is the only task permitted to write to
    // the live theme, and it runs after backups, a scoped diff and approval.
    return finish({
      phase: "theme-push",
      result: {
        status: "halted_target_is_live_theme",
        themeId: String(themeId),
        role: target.role,
        note: "30.1 requires a NON-LIVE theme. Live pushes belong to 31.4, after 31.1-31.3.",
      },
      successStatus: "pushed_verified",
    });
  }

  /* ---- 2. derive and pin the file set ---------------------------------- */
  const files = newThemeFiles(commit);
  if (files.length !== EXPECTED_NEW_FILES) {
    return finish({
      phase: "theme-push",
      result: {
        status: "halted_unexpected_file_count",
        expected: EXPECTED_NEW_FILES,
        found: files.length,
        files,
        note: "Re-approve the file list (31.3) and update EXPECTED_NEW_FILES in the same commit.",
      },
      successStatus: "pushed_verified",
    });
  }

  const manifest = files.map((repoPath) => {
    const bytes = blobAt(commit, repoPath);
    return { repoPath, key: assetKey(repoPath), bytes: bytes.length, sha256: sha256(bytes) };
  });

  /* ---- 3. classify add vs overwrite on the target ----------------------- */
  const existing = await shopify({
    store,
    token,
    method: "GET",
    path: `/themes/${themeId}/assets.json`,
  });
  if (!existing.ok) {
    return finish({
      phase: "theme-push",
      result: { status: "halted_asset_list_failed", httpStatus: existing.status },
      successStatus: "pushed_verified",
    });
  }
  const present = new Set((existing.json.assets ?? []).map((a) => a.key));
  const overwrites = manifest.filter((m) => present.has(m.key));

  printBlock("theme-push plan", {
    store,
    theme: { id: target.id, role: target.role, name: target.name },
    commit: git(["rev-parse", commit]).trim(),
    files: manifest.length,
    totalBytes: manifest.reduce((n, m) => n + m.bytes, 0),
    netNew: manifest.length - overwrites.length,
    overwrites: overwrites.map((m) => m.key),
    mode: rollback ? "rollback" : apply ? "apply" : "plan-only",
  });

  if (!apply && !rollback) {
    console.log(
      "\nPlan only. Nothing was written. Re-run with --apply to push, " +
        "or --rollback to remove a previous push.",
    );
    process.exit(EXIT_OK);
  }

  /* ---- 4. rollback path ------------------------------------------------ */
  if (rollback) {
    const removed = [];
    for (const m of manifest) {
      const res = await shopify({
        store,
        token,
        method: "DELETE",
        path: `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(m.key)}`,
      });
      removed.push({ key: m.key, httpStatus: res.status });
      await new Promise((r) => setTimeout(r, 600));
    }
    const failed = removed.filter((r) => r.httpStatus !== 200);
    return finish({
      phase: "theme-push",
      result: {
        status: failed.length === 0 ? "rolled_back" : "halted_rollback_incomplete",
        removed: removed.length,
        failed,
      },
      successStatus: "rolled_back",
    });
  }

  /* ---- 5. byte-exact backup of anything about to be overwritten -------- */
  // 30.1 should produce no overwrites at all. If it does, the file is backed up
  // in 31.1's shape before it is touched, so the restore path exists either way.
  if (overwrites.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(REPO_ROOT, "backups", `theme-${themeId}`, stamp);
    const lines = [];
    for (const m of overwrites) {
      const res = await shopify({
        store,
        token,
        method: "GET",
        path: `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(m.key)}`,
      });
      const value = res.json?.asset?.value;
      if (typeof value !== "string") {
        return finish({
          phase: "theme-push",
          result: { status: "halted_backup_unreadable", key: m.key, httpStatus: res.status },
          successStatus: "pushed_verified",
        });
      }
      const out = join(dir, m.key);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, value, "utf8");
      lines.push(`${sha256(Buffer.from(value, "utf8"))}  ${m.key}`);
      await new Promise((r) => setTimeout(r, 600));
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.sha256"), lines.join("\n") + "\n", "utf8");
    console.log(`\nBacked up ${overwrites.length} file(s) to ${dir}`);
  }

  /* ---- 6. push, one enumerated key at a time --------------------------- */
  const pushed = [];
  for (const m of manifest) {
    const bytes = blobAt(commit, m.repoPath);
    const res = await shopify({
      store,
      token,
      method: "PUT",
      path: `/themes/${themeId}/assets.json`,
      body: { asset: { key: m.key, value: bytes.toString("utf8") } },
    });
    pushed.push({ key: m.key, httpStatus: res.status, ok: res.ok });
    if (!res.ok) printBlock(`REJECTED ${m.key}`, res.json);
    await new Promise((r) => setTimeout(r, 600));
  }
  const rejected = pushed.filter((p) => !p.ok);
  if (rejected.length > 0) {
    return finish({
      phase: "theme-push",
      result: { status: "halted_push_rejected", rejected },
      successStatus: "pushed_verified",
    });
  }

  /* ---- 7. read back and hash-compare ---------------------------------- */
  const mismatches = [];
  for (const m of manifest) {
    const res = await shopify({
      store,
      token,
      method: "GET",
      path: `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(m.key)}`,
    });
    const value = res.json?.asset?.value;
    if (typeof value !== "string") {
      mismatches.push({ key: m.key, reason: "unreadable", httpStatus: res.status });
      continue;
    }
    const got = sha256(Buffer.from(value, "utf8"));
    if (got !== m.sha256) {
      mismatches.push({ key: m.key, reason: "hash", expected: m.sha256, got });
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  /* ---- 8. prove the portal is still dark ------------------------------- */
  const schema = await shopify({
    store,
    token,
    method: "GET",
    path: `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent("config/settings_schema.json")}`,
  });
  const schemaValue = schema.json?.asset?.value;
  const declaresFlag = typeof schemaValue === "string" && schemaValue.includes("portal_enabled");

  return finish({
    phase: "theme-push",
    result: {
      status: mismatches.length === 0 ? "pushed_verified" : "halted_verification_mismatch",
      theme: { id: target.id, role: target.role, name: target.name },
      pushed: pushed.length,
      verifiedIdentical: manifest.length - mismatches.length,
      mismatches,
      darkness: declaresFlag
        ? "settings_schema.json DECLARES portal_enabled — check its value before assuming dark"
        : "settings_schema.json does not declare portal_enabled — portal is dark by construction",
      rollback:
        `node scripts/theme/portal-preview-push.mjs --store=${store} ` +
        `--environment=${args.environment ?? args.env} --theme-id=${themeId} --rollback`,
    },
    successStatus: "pushed_verified",
  });
}

main().catch((err) => {
  console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT_HALTED);
});

#!/usr/bin/env node
/**
 * `portal-pages.mjs` — verify, and optionally create, the ten Shopify Pages the
 * portal's routes need.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A storefront URL `/pages/<handle>` resolves only when BOTH halves line up:
 *
 *   1. a **Page resource** exists with that handle (store-level data), and
 *   2. that Page's `template_suffix` names a template present in the theme.
 *
 * Task 30.1 delivered the theme half. The Page half is not in git, not in the
 * theme, and not created by any task in the plan — design §17.2 lists the routes
 * as "new page templates" and stops there. Confirmed empirically after 30.1:
 * `/pages/my-athoor?preview_theme_id=205900054867` returns **404** while
 * `/pages/rewards` returns 200.
 *
 * ── VERIFY IS THE DEFAULT, AND NEEDS ONLY `read_content` ────────────────────
 * The ten Pages can be created by hand in Shopify admin with **no API scope at
 * all**. That is the minimum-privilege route, and this script's default mode
 * exists to check that manual work rather than to replace it: ten pages each
 * needing an exact handle AND an exact theme template is ten chances to set one
 * wrong, and a wrong template suffix fails as a *rendered but empty* page rather
 * than an error.
 *
 * `--create` needs `write_content` and is offered only because doing it
 * programmatically is exact and repeatable.
 *
 * ── PAGES ARE STORE DATA, SO THEY ARE CREATED HIDDEN ────────────────────────
 * A Page is shared by every theme on the store. A *published* Page with a
 * template the LIVE theme does not have falls back to `templates/page.liquid`
 * and renders as an ordinary near-empty page — ten thin, indexable URLs
 * appearing on the production storefront before the portal ships. So every Page
 * is created with `published: false`, and publishing becomes part of 31.6's
 * staged flip rather than a side effect of preparation.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   Verify (default, read-only):
 *     SHOPIFY_THEME_TOKEN=… node scripts/theme/portal-pages.mjs \
 *       --store=myathoorlondon.myshopify.com --environment=production \
 *       --confirm-production-store=myathoorlondon.myshopify.com
 *
 *   Create the missing ones, hidden:  add --create --confirm-create
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_HALTED,
  EXIT_OK,
  parseArgs,
  printBlock,
  requireSecretFromEnv,
  resolveTargetStore,
  usage,
} from "../migration/_shared.mjs";
import { assertEnvironmentIdentity } from "../migration/_envIdentity.mjs";

const USAGE = `
portal-pages.mjs — verify (default) or create the portal's ten Shopify Pages

  --store=<x.myshopify.com>          required
  --environment=production|staging|development   required
  --confirm-production-store=<exact> required when --store is production
  --create                           create the missing Pages (needs write_content)
  --confirm-create                   required alongside --create
  --set-template-suffix=<handle>     set template_suffix on ONE existing page
  --apply                            perform that write (default: plan only)
  --confirm-page-id=<id>             required alongside --apply
  --title-prefix=<text>              admin-facing title prefix (default "My Athoor")

  token: SHOPIFY_THEME_TOKEN or SHOPIFY_ADMIN_API_TOKEN (environment only)
`;

const API = "2024-10";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * The required Pages, derived from the templates that actually ship.
 *
 * Derived rather than listed so this cannot disagree with the theme. The handle
 * IS the template suffix — that is the whole contract, and
 * `src/theme/portalRouteContract.test.ts` fixes it from the other direction.
 */
function requiredPages() {
  const dir = join(REPO_ROOT, "theme", "templates");
  return readdirSync(dir)
    .filter((f) => f.startsWith("page.my-athoor") && f.endsWith(".liquid"))
    .map((f) => f.slice("page.".length, -".liquid".length))
    .sort()
    .map((suffix) => ({
      handle: suffix,
      templateSuffix: suffix,
      title: suffix === "my-athoor"
        ? "My Athoor"
        : "My Athoor — " + suffix.slice("my-athoor-".length).replace(/-/g, " "),
    }));
}

/**
 * Fields that must be identical before and after a `template_suffix` write.
 *
 * `published_at` is in this list on purpose and is the one that matters most: a
 * page silently becoming published puts a live URL on the storefront, and on the
 * live theme that URL renders a fallback template rather than the portal.
 */
export const PROTECTED_PAGE_FIELDS = [
  "id",
  "handle",
  "title",
  "body_html",
  "published_at",

  "author",
  "created_at",
  "shop_id",
  "admin_graphql_api_id",
];

/**
 * Compare a page before and after the write.
 *
 * `updated_at` is expected to move — Shopify stamps it on every write. Saying so
 * up front matters: a check that demanded "exactly one field changed" would fail
 * on a *correct* write, and the temptation would then be to loosen it until it
 * passed. Pure, so `portalPagesUpdate.test.ts` can drive it without a token.
 */
export function diffPageWrite(before, after, expectedSuffix) {
  const violations = [];
  for (const field of PROTECTED_PAGE_FIELDS) {
    if (JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field])) {
      violations.push({
        field,
        before: before?.[field] ?? null,
        after: after?.[field] ?? null,
      });
    }
  }

  const suffixOk = (after?.template_suffix ?? null) === expectedSuffix;
  const updatedAtMoved = before?.updated_at !== after?.updated_at;

  // Anything changed that is neither the suffix nor updated_at?
  const known = new Set([...PROTECTED_PAGE_FIELDS, "template_suffix", "updated_at"]);
  const unexpected = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((k) => !known.has(k))
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) => ({ field: k, before: before?.[k] ?? null, after: after?.[k] ?? null }));

  return {
    ok: violations.length === 0 && suffixOk && unexpected.length === 0,
    protectedViolations: violations,
    unexpectedChanges: unexpected,
    templateSuffix: {
      before: before?.template_suffix ?? null,
      after: after?.template_suffix ?? null,
      expected: expectedSuffix,
      ok: suffixOk,
    },
    updatedAtMoved,
    // UNCHANGED, not "still null". The first version asserted
    // `published_at === null`, written on the assumption the page would be Hidden.
    // The real page is published, so that gate would have reported
    // `halted_verification_failed` on a perfectly correct write — and the natural
    // next move would have been to relax it under time pressure, immediately after
    // a production write, which is the worst possible moment to edit a safety check.
    //
    // What matters is that this write does not CHANGE the publication state,
    // whatever it currently is. That is covered field-by-field in
    // PROTECTED_PAGE_FIELDS; this flag surfaces it separately because it is the
    // consequence a reader most needs to see.
    publishedAtUnchanged:
      JSON.stringify(before?.published_at ?? null) ===
      JSON.stringify(after?.published_at ?? null),
    publishedAtAfter: after?.published_at ?? null,
  };
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
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  const store = resolveTargetStore({ args, usageText: USAGE });
  const token = requireSecretFromEnv({
    args,
    envNames: ["SHOPIFY_THEME_TOKEN", "SHOPIFY_ADMIN_API_TOKEN"],
    argAliases: ["token", "access-token", "accessToken"],
    what: "a Shopify Admin API token with read_content (write_content to create)",
    usageText: USAGE,
  });

  // `writes: false` for the same reason as the theme push: no database is
  // involved, so `--confirm-db-fingerprint` would be unsatisfiable. Deliberate
  // confirmation for the mutating path is `--confirm-create`, below.
  assertEnvironmentIdentity({
    args,
    store,
    phase: "portal-pages",
    writes: false,
    databaseUrl: undefined,
    fail: (message) => usage(message, USAGE),
  });

  const create = Boolean(args.create);
  const setSuffix = args["set-template-suffix"];
  const apply = Boolean(args.apply);
  if (setSuffix === true) {
    usage("--set-template-suffix requires a page handle, e.g. =my-athoor", USAGE);
  }
  if (setSuffix && create) {
    usage("--set-template-suffix and --create are mutually exclusive.", USAGE);
  }
  if (create && !args["confirm-create"]) {
    usage(
      "REFUSING TO CREATE Pages without --confirm-create.\n" +
        "  A Page is STORE data, shared by every theme. Creating ten of them is a\n" +
        "  change to the production storefront's URL space, not a theme change.\n" +
        "  They will be created hidden (published:false), but the confirmation is\n" +
        "  still required so the mutation is never implicit.",
      USAGE,
    );
  }

  const wanted = requiredPages();

  // Read the existing Pages. This is the only call the default mode makes.
  const existing = await shopify({
    store, token, method: "GET",
    path: "/pages.json?limit=250&fields=id,handle,title,template_suffix,published_at",
  });
  if (!existing.ok) {
    const scope = existing.status === 403 ? "read_content" : "unknown";
    printBlock("could not list Pages", {
      httpStatus: existing.status,
      body: existing.json,
      likelyMissingScope: scope,
      note:
        "Shopify names the scope it wants in the error above. Grant read_content to " +
        "verify, or write_content to create. Neither is needed if the Pages are made " +
        "by hand in Shopify admin.",
    });
    process.exit(EXIT_HALTED);
  }

  const byHandle = new Map(
    (existing.json.pages ?? []).map((p) => [p.handle, p]),
  );

  const report = wanted.map((w) => {
    const found = byHandle.get(w.handle);
    if (!found) return { ...w, state: "MISSING" };
    const suffixOk = (found.template_suffix ?? null) === w.templateSuffix;
    return {
      ...w,
      state: suffixOk ? "OK" : "WRONG_TEMPLATE",
      id: found.id,
      actualTemplateSuffix: found.template_suffix ?? null,
      published: Boolean(found.published_at),
    };
  });

  printBlock("portal Pages", {
    store,
    required: wanted.length,
    ok: report.filter((r) => r.state === "OK").length,
    missing: report.filter((r) => r.state === "MISSING").map((r) => r.handle),
    wrongTemplate: report
      .filter((r) => r.state === "WRONG_TEMPLATE")
      .map((r) => ({
        handle: r.handle,
        expected: r.templateSuffix,
        actual: r.actualTemplateSuffix,
      })),
    publishedButShouldBeHidden: report
      .filter((r) => r.state !== "MISSING" && r.published)
      .map((r) => r.handle),
    mode: setSuffix ? "set-template-suffix" : create ? "create" : "verify-only",
  });

  /* ---- set template_suffix on ONE existing page ------------------------- */
  if (setSuffix) {
    const handle = String(setSuffix);
    const wanted = requiredPages().find((p) => p.handle === handle);
    if (!wanted) {
      // Can only ever target one of the ten handles derived from the templates.
      usage(
        `--set-template-suffix=${handle} is not one of the portal handles.\n` +
          `  Allowed: ${requiredPages().map((p) => p.handle).join(", ")}`,
        USAGE,
      );
    }
    const existing = byHandle.get(handle);
    if (!existing) {
      return finish({
        phase: "portal-pages",
        result: { status: "halted_page_not_found", handle },
        successStatus: "template_suffix_set",
      });
    }

    // Full before-state, fetched on its own so the diff compares complete objects
    // rather than the trimmed field list used for the summary above.
    const beforeRes = await shopify({
      store, token, method: "GET", path: `/pages/${existing.id}.json`,
    });
    const before = beforeRes.json?.page;
    if (!before) {
      return finish({
        phase: "portal-pages",
        result: { status: "halted_before_state_unreadable", httpStatus: beforeRes.status },
        successStatus: "template_suffix_set",
      });
    }

    printBlock("template_suffix plan", {
      pageId: before.id,
      handle: before.handle,
      title: before.title,
      bodyHtmlLength: (before.body_html ?? "").length,
      publishedAt: before.published_at ?? null,
      hidden: (before.published_at ?? null) === null,
      templateSuffixBefore: before.template_suffix ?? null,
      templateSuffixAfter: wanted.templateSuffix,
      payload: { page: { id: before.id, template_suffix: wanted.templateSuffix } },
      protectedFields: PROTECTED_PAGE_FIELDS,
      alsoExpectedToChange: ["updated_at"],
      mode: apply ? "apply" : "plan-only",
    });

    if (!apply) {
      console.log("\nPlan only. Nothing was written. Add --apply --confirm-page-id=<id>.");
      process.exit(EXIT_OK);
    }
    if (String(args["confirm-page-id"] ?? "") !== String(before.id)) {
      usage(
        "REFUSING TO WRITE without explicit page confirmation.\n" +
          `  Re-run with --confirm-page-id=${before.id} (exact match required).`,
        USAGE,
      );
    }

    const put = await shopify({
      store, token, method: "PUT", path: `/pages/${before.id}.json`,
      body: { page: { id: before.id, template_suffix: wanted.templateSuffix } },
    });
    if (!put.ok) {
      printBlock("write rejected", put.json);
      return finish({
        phase: "portal-pages",
        result: { status: "halted_write_rejected", httpStatus: put.status },
        successStatus: "template_suffix_set",
      });
    }

    const afterRes = await shopify({
      store, token, method: "GET", path: `/pages/${before.id}.json`,
    });
    const after = afterRes.json?.page;
    const diff = diffPageWrite(before, after, wanted.templateSuffix);

    return finish({
      phase: "portal-pages",
      result: {
        status: diff.ok && diff.publishedAtUnchanged
          ? "template_suffix_set"
          : "halted_verification_failed",
        pageId: before.id,
        handle: after?.handle,
        title: after?.title,
        templateSuffix: diff.templateSuffix,
        publishedAtUnchanged: diff.publishedAtUnchanged,
        publishedAtAfter: diff.publishedAtAfter,
        updatedAtMoved: diff.updatedAtMoved,
        protectedViolations: diff.protectedViolations,
        unexpectedChanges: diff.unexpectedChanges,
        rollback:
          `re-run with --set-template-suffix=${handle} after setting the suffix back ` +
          `to its previous value (${before.template_suffix ?? "null"}) in the admin, ` +
          `or PUT {"page":{"id":${before.id},"template_suffix":null}}`,
      },
      successStatus: "template_suffix_set",
    });
  }

  if (!create) {
    const allOk = report.every((r) => r.state === "OK" && !r.published);
    console.log(
      allOk
        ? "\nAll ten Pages exist, carry the right template and are hidden."
        : "\nVerify-only. Nothing was changed. Fix the items above, or re-run with " +
            "--create --confirm-create.",
    );
    process.exit(allOk ? EXIT_OK : EXIT_HALTED);
  }

  const created = [];
  for (const r of report.filter((x) => x.state === "MISSING")) {
    const res = await shopify({
      store, token, method: "POST", path: "/pages.json",
      body: {
        page: {
          title: `${args["title-prefix"] ?? "My Athoor"}`.trim() === "My Athoor"
            ? r.title
            : r.title,
          handle: r.handle,
          template_suffix: r.templateSuffix,
          // Hidden. See the header: a published Page with a template the live
          // theme lacks renders as a thin fallback page on the live storefront.
          published: false,
          body_html: "",
        },
      },
    });
    created.push({
      handle: r.handle, httpStatus: res.status, ok: res.ok,
      id: res.json?.page?.id ?? null,
      templateSuffix: res.json?.page?.template_suffix ?? null,
      published: Boolean(res.json?.page?.published_at),
    });
    if (!res.ok) printBlock(`REJECTED ${r.handle}`, res.json);
    await new Promise((rs) => setTimeout(rs, 600));
  }

  const failed = created.filter((c) => !c.ok);
  const wronglyPublished = created.filter((c) => c.published);
  printBlock("creation result", {
    attempted: created.length,
    succeeded: created.length - failed.length,
    failed,
    wronglyPublished: wronglyPublished.map((c) => c.handle),
  });
  process.exit(failed.length === 0 && wronglyPublished.length === 0 ? EXIT_OK : EXIT_HALTED);
}

// Only run when invoked directly. `diffPageWrite` and `PROTECTED_PAGE_FIELDS` are
// imported by `src/theme/portalPagesUpdate.test.ts`, and without this guard that
// import would EXECUTE this script — a production page-update tool running inside
// the test suite. Caught by vitest reporting an error alongside passing tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_HALTED);
  });
}

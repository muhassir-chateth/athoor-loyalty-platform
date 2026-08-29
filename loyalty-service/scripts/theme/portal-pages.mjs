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
    mode: create ? "create" : "verify-only",
  });

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

main().catch((err) => {
  console.error(`\nUNEXPECTED FAILURE: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT_HALTED);
});

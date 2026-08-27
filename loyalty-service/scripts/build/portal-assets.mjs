#!/usr/bin/env node
/**
 * Build the portal's theme assets from `theme-src/portal/**` (spec task 7.1,
 * design §16.7).
 *
 *   node scripts/build/portal-assets.mjs            build and write
 *   node scripts/build/portal-assets.mjs --check    build and compare; write nothing
 *
 * WHAT IT PRODUCES
 * ----------------
 *   theme/assets/athoor-portal-core.js          the core bundle
 *   theme/assets/athoor-portal-<section>.js     one per section, ten of them
 *   theme/assets/athoor-portal.css              one stylesheet, all partials
 *
 * All IIFE, ES2019, minified, no polyfill, no runtime dependency — the settings
 * design §16.7 specifies, each justified at its `esbuild` option below.
 *
 * WHY THE ARTEFACTS ARE COMMITTED
 * -------------------------------
 * Design §16.7: "a theme push must never require a build". Design §25.5 is the
 * reason it is not merely a preference — the scoped-push procedure approves a
 * DIFF of specific files and then pushes those files, so a build step between
 * approval and push would mean the approved bytes and the pushed bytes are not
 * provably the same. Committing the output makes them the same object.
 *
 * That guarantee is only as good as the artefacts being current, which is what
 * `--check` is for: it rebuilds into memory and compares against what is on disk,
 * so a source edit that was never rebuilt fails CI instead of shipping stale
 * bytes. This depends on esbuild being byte-deterministic for identical input,
 * which is why the exact version pin of design §16.7 is load-bearing here and not
 * only a supply-chain measure.
 *
 * WHERE THIS SCRIPT LIVES, AND WHY IT REACHES UPWARDS
 * ---------------------------------------------------
 * The repository has no root `package.json`. `loyalty-service/` is the only npm
 * package, so `esbuild` can only be a devDependency there, and the script that
 * invokes it lives alongside it. Its inputs (`../theme-src`) and outputs
 * (`../theme/assets`) are therefore both outside its own package. Design §16.2
 * places the source at the repository root deliberately — "TypeScript source —
 * NOT in theme/" — because everything under `theme/` is pushable to Shopify and
 * source is not.
 *
 * SAFETY: reads `theme-src/**`, writes only the eleven `.js` files and the one
 * `.css` file named above. It creates no directory, deletes nothing, and touches
 * none of the 126 pre-existing files in `theme/assets/`. `--check` writes nothing
 * at all.
 *
 * _Requirements: 20.1, 19.8, 18.3_
 */
import { build } from "esbuild";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root — `loyalty-service/scripts/build` is three levels down. */
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "theme-src", "portal");
const OUT_DIR = path.join(REPO_ROOT, "theme", "assets");

const ASSET_PREFIX = "athoor-portal";
const CORE_ENTRY = path.join(SRC_DIR, "core.ts");
const SECTIONS_DIR = path.join(SRC_DIR, "sections");
const CSS_ENTRY = path.join(SRC_DIR, "styles", "athoor-portal.css");

/**
 * Files in `sections/` that are NOT section entry points.
 *
 * `registration.ts` is the shared shim every section bundle inlines (task 7.1).
 * `register.ts` is the core-side boot scan and error boundary of task 18.7; it
 * does not exist yet and is listed now so that creating it cannot accidentally
 * emit a twelfth bundle called `athoor-portal-register.js`.
 */
const NOT_SECTIONS = new Set(["registration.ts", "register.ts"]);

/**
 * Compressed-size budgets, in bytes (Requirement 18.3, design §21.2).
 *
 * The JavaScript budget is PER PAGE, not per file: a section page loads core plus
 * exactly one section bundle, so the quantity to compare is that pair. Measuring
 * each file against 40 KB separately would report eleven comfortable numbers
 * while the pages they compose could each be over.
 *
 * Task 29.11 makes these build-failing. This script reports them, and says so —
 * see `report()`.
 */
const BUDGET_JS_PER_PAGE = 40 * 1024;
const BUDGET_CSS = 20 * 1024;

/**
 * `orderDetail` -> `order-detail`.
 *
 * Design §16.2 names the source module `orderDetail.ts`; every file in
 * `theme/assets/` is kebab-case. One transformation reconciles the two, applied
 * to the file name only. The section NAME the bundle registers is whatever the
 * module passes to `registerSection`, and the smoke test asserts the two agree —
 * so a divergence is caught rather than inferred.
 */
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The esbuild options shared by the core and section bundles. */
const jsOptions = {
  bundle: true,

  // IIFE, not ESM: a Shopify asset is served to a browser as-is, and an `iife`
  // wrapper keeps every module-scoped name private. That privacy is what makes
  // "no global beyond a single namespaced entry" (design §16.7) achievable at
  // all, and what the smoke test verifies.
  format: "iife",

  // ES2019 downlevels SYNTAX only — esbuild adds no polyfill and pulls in no
  // helper library, which is what "no runtime dependency" means for the emitted
  // asset (design §16.7). The floor is set by the theme's existing baseline,
  // which already ships untranspiled `class` syntax in `dt_wishlist.js`. Library
  // calls are NOT downlevelled by any bundler, so the matching guard is the
  // `lib: ["ES2019", ...]` setting in `theme-src/tsconfig.json`: that is what
  // makes an ES2020+ builtin a compile error rather than a runtime failure in an
  // older browser.
  target: "es2019",

  platform: "browser",
  minify: true,

  // No source map. A `.map` in `theme/assets/` would be pushed to Shopify and
  // served publicly, publishing the portal's source for no benefit a customer
  // receives — and it would add files to the scoped-push list of design §25.5
  // that carry no reviewed diff.
  sourcemap: false,

  // Deterministic output for `--check`. `charset: "utf8"` stops esbuild escaping
  // non-ASCII into `\uXXXX`, which keeps any future copy legible in a diff.
  charset: "utf8",
  legalComments: "inline",

  // Return the bytes instead of writing them. Every write in this script goes
  // through `emit()`, so `--check` cannot write by accident: there is no code
  // path in which esbuild itself touches the output directory.
  write: false,
};

/** Discovers the section entry points, sorted, so output order is stable. */
async function findSectionEntries() {
  const files = await readdir(SECTIONS_DIR);
  return files
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !NOT_SECTIONS.has(f))
    .sort()
    .map((file) => ({
      entry: path.join(SECTIONS_DIR, file),
      asset: `${ASSET_PREFIX}-${kebab(path.basename(file, ".ts"))}.js`,
    }));
}

async function buildOne(entry, asset) {
  const result = await build({ ...jsOptions, entryPoints: [entry] });
  const [out] = result.outputFiles;
  if (!out) throw new Error(`esbuild produced no output for ${entry}`);
  return { asset, contents: out.contents };
}

async function buildCss() {
  const result = await build({
    entryPoints: [CSS_ENTRY],
    bundle: true, // resolves the `@import`s into one file
    minify: true,
    // Matches the JS floor. It governs which CSS features esbuild is willing to
    // lower, so a future partial cannot rely on syntax the browser baseline
    // predates.
    target: "es2019",
    charset: "utf8",
    // Keeps the `/*! ... */` provenance banner through minification — see the
    // reasoning in `styles/athoor-portal.css`.
    legalComments: "inline",
    loader: { ".css": "css" },
    write: false,
  });
  const [out] = result.outputFiles;
  if (!out) throw new Error("esbuild produced no CSS output");
  return { asset: `${ASSET_PREFIX}.css`, contents: out.contents };
}

/** gzip and brotli, both at maximum, because that is what a CDN serves. */
function compressed(bytes) {
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

/** A short content digest, for naming a difference `--check` found. */
const digest = (bytes) =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 12);

function report(artefacts) {
  const core = artefacts.find((a) => a.asset === `${ASSET_PREFIX}-core.js`);
  const css = artefacts.find((a) => a.asset.endsWith(".css"));
  const sections = artefacts.filter(
    (a) => a.asset.endsWith(".js") && a !== core,
  );

  console.log(`\n  ${"asset".padEnd(38)} ${"raw".padStart(10)} ${"gzip".padStart(10)} ${"brotli".padStart(10)}`);
  console.log(`  ${"-".repeat(38)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(10)}`);
  for (const a of artefacts) {
    const s = compressed(a.contents);
    console.log(
      `  ${a.asset.padEnd(38)} ${kb(s.raw).padStart(10)} ${kb(s.gzip).padStart(10)} ${kb(s.brotli).padStart(10)}`,
    );
  }

  // The budget that actually applies: core + the LARGEST section bundle is the
  // worst page. Reporting the worst case is the only reading that cannot be
  // passed by a page nobody measured.
  if (core && sections.length > 0) {
    const coreSize = compressed(core.contents);
    const worst = sections
      .map((a) => ({ asset: a.asset, size: compressed(a.contents) }))
      .sort((a, b) => b.size.gzip - a.size.gzip)[0];
    const pageGzip = coreSize.gzip + worst.size.gzip;
    const pageBrotli = coreSize.brotli + worst.size.brotli;
    console.log(
      `\n  worst section page (core + ${worst.asset}):` +
        ` ${kb(pageGzip)} gzip, ${kb(pageBrotli)} brotli` +
        ` — budget ${kb(BUDGET_JS_PER_PAGE)} JS (Requirement 18.3)`,
    );
    if (pageGzip > BUDGET_JS_PER_PAGE) {
      console.log("  OVER THE JS BUDGET.");
    }
  }

  if (css) {
    const s = compressed(css.contents);
    console.log(
      `  stylesheet: ${kb(s.gzip)} gzip, ${kb(s.brotli)} brotli` +
        ` — budget ${kb(BUDGET_CSS)} CSS (Requirement 18.3)`,
    );
    if (s.gzip > BUDGET_CSS) console.log("  OVER THE CSS BUDGET.");
  }

  // Stated rather than implied, so nobody reads this table as a gate.
  console.log(
    "\n  Sizes are REPORTED, not enforced. The build-failing budget gate is task 29.11.",
  );
}

async function emit(artefacts) {
  for (const a of artefacts) {
    await writeFile(path.join(OUT_DIR, a.asset), a.contents);
  }
  console.log(`\n  Wrote ${artefacts.length} artefacts to theme/assets/.`);
}

/**
 * Rebuild and compare against disk. Non-zero exit on any difference — a stale
 * committed artefact is a §25.5 failure waiting to happen, not a formatting nit.
 */
async function check(artefacts) {
  const stale = [];
  for (const a of artefacts) {
    const target = path.join(OUT_DIR, a.asset);
    let onDisk;
    try {
      onDisk = await readFile(target);
    } catch {
      stale.push(`${a.asset}: missing from theme/assets/`);
      continue;
    }
    if (!onDisk.equals(Buffer.from(a.contents))) {
      // Both the length and a digest, because a same-length difference is the
      // common case — a renamed identifier or a changed literal — and reporting
      // only the length would read as "no difference" on exactly those.
      stale.push(
        `${a.asset}: committed ${onDisk.byteLength} bytes (${digest(onDisk)}), ` +
          `rebuild ${a.contents.byteLength} bytes (${digest(a.contents)})`,
      );
    }
  }

  if (stale.length > 0) {
    console.error(
      "\n  The committed portal artefacts do not match theme-src/portal/**:\n" +
        stale.map((s) => `    - ${s}`).join("\n") +
        "\n\n  Run `npm run build:portal` in loyalty-service/ and commit the result." +
        "\n  Design §25.5 requires the approved bytes and the pushed bytes to be the same" +
        "\n  object, which only holds while the committed artefacts are current.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n  Committed artefacts match the source.");
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  const sectionEntries = await findSectionEntries();
  if (sectionEntries.length === 0) {
    throw new Error(`No section entry points found in ${SECTIONS_DIR}`);
  }

  const artefacts = [
    await buildOne(CORE_ENTRY, `${ASSET_PREFIX}-core.js`),
    ...(await Promise.all(
      sectionEntries.map(({ entry, asset }) => buildOne(entry, asset)),
    )),
    await buildCss(),
  ];

  report(artefacts);
  if (checkOnly) await check(artefacts);
  else await emit(artefacts);
}

main().catch((err) => {
  // The message only. A stack trace from a build script is noise in CI output,
  // and esbuild's own errors are already precise about file and line.
  console.error(`\n  portal build failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

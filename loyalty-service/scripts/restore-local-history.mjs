/**
 * Restore working-tree files from Kiro's local history.
 *
 * WHY THIS EXISTS: a `git reset --hard` discarded uncommitted modifications to
 * tracked files. Unstaged changes are not recoverable from git — they were never
 * objects — but the editor's own local history retains every saved version.
 *
 * Dry run by default. Pass --apply to write. Reports, for each requested path,
 * the newest history version and whether it differs from what is on disk now.
 *
 * Usage, from loyalty-service:
 *   node scripts/restore-local-history.mjs                 # dry run, all paths
 *   node scripts/restore-local-history.mjs --apply         # write them
 */
import fs from "fs";
import path from "path";

const HISTORY_ROOT = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/Kiro/User/History",
);
const REPO = path.resolve(import.meta.dirname, "..", "..");
const apply = process.argv.includes("--apply");

/** The tracked files whose uncommitted modifications the reset discarded. */
const TARGETS = [
  ".gitignore",
  "loyalty-service/src/theme/marqueeClone.dom.test.ts",
  "theme/assets/athoor-custom.css",
  "theme/assets/athoor-loyalty.js",
  "theme/assets/product-form.js",
  "theme/config/settings_data.json",
  "theme/layout/theme.liquid",
  "theme/locales/en.default.json",
  "theme/sections/athoor-bestsellers-marquee.liquid",
  "theme/sections/athoor-edp.liquid",
  "theme/sections/main-product.liquid",
  "theme/snippets/card-product.liquid",
  "theme/snippets/cart-drawer.liquid",
  "theme/templates/collection.json",
  "theme/templates/page.fragrances.json",
];

if (!fs.existsSync(HISTORY_ROOT)) {
  console.error(`No local history at ${HISTORY_ROOT}`);
  process.exit(2);
}

/** Index history: absolute file path -> newest { file, timestamp }. */
const index = new Map();
for (const dir of fs.readdirSync(HISTORY_ROOT)) {
  const entriesPath = path.join(HISTORY_ROOT, dir, "entries.json");
  if (!fs.existsSync(entriesPath)) continue;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(entriesPath, "utf8"));
  } catch {
    continue;
  }
  if (typeof meta.resource !== "string" || !Array.isArray(meta.entries)) continue;
  let filePath;
  try {
    filePath = decodeURIComponent(new URL(meta.resource).pathname);
  } catch {
    continue;
  }
  const newest = meta.entries.reduce(
    (best, e) => (best === null || e.timestamp > best.timestamp ? e : best),
    null,
  );
  if (!newest) continue;
  const candidate = {
    file: path.join(HISTORY_ROOT, dir, newest.id),
    timestamp: newest.timestamp,
    versions: meta.entries.length,
  };
  const existing = index.get(filePath);
  if (!existing || candidate.timestamp > existing.timestamp) {
    index.set(filePath, candidate);
  }
}

let restored = 0;
let unchanged = 0;
let missing = 0;

console.log(apply ? "\nRESTORING FROM LOCAL HISTORY\n" : "\nDRY RUN — no files written\n");

for (const rel of TARGETS) {
  const abs = path.join(REPO, rel);
  const hist = index.get(abs);
  if (!hist || !fs.existsSync(hist.file)) {
    console.log(`NO HISTORY   ${rel}`);
    missing += 1;
    continue;
  }
  const recovered = fs.readFileSync(hist.file, "utf8");
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  const when = new Date(hist.timestamp).toISOString();

  if (current === recovered) {
    console.log(`ALREADY OK   ${rel}  (newest ${when})`);
    unchanged += 1;
    continue;
  }

  console.log(
    `RESTORE      ${rel}\n` +
      `             newest ${when}, ${hist.versions} versions, ` +
      `${current === null ? "absent" : current.length + " bytes"} -> ${recovered.length} bytes`,
  );
  if (apply) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, recovered);
  }
  restored += 1;
}

console.log(
  `\n${apply ? "restored" : "would restore"}: ${restored}   already correct: ${unchanged}   ` +
    `no history: ${missing}`,
);
if (!apply && restored > 0) console.log("\nRe-run with --apply to write these.");

/**
 * READ-ONLY snapshot of named assets from the LIVE Shopify theme.
 *
 * WHY THIS EXISTS: an accidental `git reset --hard` discarded uncommitted
 * modifications to tracked theme files. Unstaged changes are unrecoverable from
 * git, and the editor's local history only had 6 of the 15. For the rest the
 * LIVE THEME is the authoritative record of what is actually deployed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - it never writes to `theme/` — output goes to a timestamped snapshot
 *     directory, so a recovered copy can be DIFFED and adopted deliberately
 *     rather than silently overwriting whatever is on disk now;
 *   - it never writes to Shopify. The only HTTP verb used is GET.
 *
 * Two mistakes are worth not repeating: overwriting files to "fix" them is how
 * the original damage happened, and a recovery step that clobbers is the same
 * class of error one layer up.
 *
 * The credential comes from the workspace MCP configuration — the same source
 * `scripts/probe-admin.mjs` already uses — and is never printed.
 *
 * Usage, from the loyalty-service directory:
 *   node scripts/fetch-live-theme-assets.mjs                 # default theme + file list
 *   node scripts/fetch-live-theme-assets.mjs <themeId>
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MCP_CONFIG = "/Users/muhassirjuman/kiro_athoor/.kiro/settings/mcp.json";
const REPO = resolve(import.meta.dirname, "..", "..");
const LIVE_THEME_ID = process.argv[2] ?? "180956594515";

/** The tracked theme files whose local modifications the reset discarded. */
const KEYS = [
  "assets/product-form.js",
  "config/settings_data.json",
  "layout/theme.liquid",
  "sections/athoor-bestsellers-marquee.liquid",
  "sections/athoor-edp.liquid",
  "sections/main-product.liquid",
  "snippets/cart-drawer.liquid",
  "templates/collection.json",
  "templates/page.fragrances.json",
  // Included as a CONTROL: local history already recovered this one and it was
  // proven byte-identical to the deployed source via the CDN source map. If the
  // snapshot of this file does not match the local copy, the fetch itself is
  // suspect and every other result here should be distrusted.
  "assets/athoor-loyalty.js",
];

function readShopifyCreds() {
  const cfg = JSON.parse(readFileSync(MCP_CONFIG, "utf8"));
  const servers = cfg.mcpServers ?? cfg.servers ?? {};
  const entry = servers.shopify ?? servers["shopify-themes"];
  if (!entry) throw new Error("No shopify MCP server entry found.");
  const args = (entry.args ?? []).map(String);
  const pick = (flag) => {
    const hit = args.find((a) => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : undefined;
  };
  const domain = pick("domain");
  const accessToken = pick("accessToken");
  const apiVersion = pick("apiVersion") ?? "2024-10";
  if (!domain || !accessToken) throw new Error("domain/accessToken missing.");
  return { domain, accessToken, apiVersion };
}

const { domain, accessToken, apiVersion } = readShopifyCreds();

const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, 15) + "Z";
const outDir = join(REPO, "docs", "ops", `live-theme-recovery-${stamp}`);

async function fetchAsset(key) {
  const url =
    `https://${domain}/admin/api/${apiVersion}/themes/${LIVE_THEME_ID}/assets.json` +
    `?asset[key]=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = await res.json();
  const asset = body?.asset;
  if (!asset) return { ok: false, status: res.status, reason: "no asset in response" };
  if (typeof asset.value === "string") return { ok: true, text: asset.value };
  if (typeof asset.attachment === "string") {
    return { ok: true, text: Buffer.from(asset.attachment, "base64").toString("utf8") };
  }
  return { ok: false, status: res.status, reason: "asset has neither value nor attachment" };
}

console.log(`\nLIVE THEME ASSET SNAPSHOT (read-only)\n`);
console.log(`shop     : ${domain}`);
console.log(`theme    : ${LIVE_THEME_ID}`);
console.log(`snapshot : ${outDir}\n`);

let same = 0;
let differs = 0;
let failed = 0;

for (const key of KEYS) {
  const result = await fetchAsset(key);
  if (!result.ok) {
    console.log(`FETCH FAIL  ${key}  (HTTP ${result.status}${result.reason ? ", " + result.reason : ""})`);
    failed += 1;
    continue;
  }

  const target = join(outDir, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.text);

  const localPath = join(REPO, "theme", key);
  if (!existsSync(localPath)) {
    console.log(`SNAPSHOT    ${key}  (no local file to compare)`);
    differs += 1;
    continue;
  }
  const local = readFileSync(localPath, "utf8");
  if (local === result.text) {
    console.log(`MATCHES     ${key}  (local already equals live)`);
    same += 1;
  } else {
    console.log(
      `DIFFERS     ${key}  local ${local.length} chars vs live ${result.text.length} chars`,
    );
    differs += 1;
  }
}

console.log(
  `\nmatches: ${same}   differs: ${differs}   fetch failures: ${failed}\n` +
    `Nothing in theme/ was modified. Review the snapshot and adopt files deliberately.`,
);

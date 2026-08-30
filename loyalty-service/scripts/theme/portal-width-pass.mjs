#!/usr/bin/env node
/**
 * portal-width-pass.mjs — task 30.3 measured in a REAL layout engine.
 *
 * Chrome over CDP with Node's built-in WebSocket, so nothing is added to package.json
 * (task 29.10 pins the dependency set; task 33 requires npm ls --omit=dev unchanged).
 *
 * Markup and CSS come from `.width-fixture/`, produced by `portalWidthFixtureDump.test.ts`
 * from `sectionHtml()`, which reads `theme/snippets/portal-section.liquid` at run time.
 * Reconstructing markup here would let it drift from the shipped Liquid, and a width pass
 * measuring stale markup is worse than none because it reports a pass.
 *
 * WHAT THIS DOES AND DOES NOT COVER
 *   covered     — scrollWidth <= width per section at all eight widths; the fixed bottom bar
 *                 below 750 releasing at 768; five bar targets at 320 with their measured
 *                 heights; the wishlist 1-up/2-up boundary at 375 vs 390.
 *   NOT covered — the live storefront render, which needs an authenticated preview session,
 *                 and the mobile-keyboard case, which needs a real device.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9444;
const WIDTHS = [320, 375, 390, 414, 768, 1024, 1280, 1920];
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", ".width-fixture");

const sections = JSON.parse(readFileSync(join(FIXTURE, "sections.json"), "utf8"));
const css = readFileSync(join(FIXTURE, "athoor-portal.css"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(BIN, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/cdp-profile-widths", "--no-first-run", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error("Chrome exposed no debugger socket");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res) => { id += 1; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const { result: t } = await send("Target.createTarget", { url: "about:blank" });
const { result: a } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const S = a.sessionId;
await send("Page.enable", {}, S);
await send("Runtime.enable", {}, S);

const results = [];
for (const [name, html] of Object.entries(sections)) {
  const doc = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}html,body{margin:0;padding:0}${css}</style></head><body>${html}</body></html>`;
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride",
      { width, height: 900, deviceScaleFactor: 1, mobile: width < 750 }, S);
    await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(doc)}` }, S);
    await sleep(220);
    const { result: ev } = await send("Runtime.evaluate", {
      expression: `(() => {
        const de = document.documentElement;
        const bar = document.querySelector('.athoor-portal__nav');
        const barStyle = bar ? getComputedStyle(bar) : null;
        const links = [...document.querySelectorAll('.athoor-portal__nav-link')];
        const visible = links.filter(l => {
          const r = l.getBoundingClientRect();
          const s = getComputedStyle(l);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        });
        const grid = document.querySelector('.athoor-wishlist__grid, [class*="wishlist"][class*="grid"]');
        return JSON.stringify({
          scrollWidth: de.scrollWidth,
          clientWidth: de.clientWidth,
          barPosition: barStyle ? barStyle.position : null,
          visibleTargets: visible.length,
          minTargetHeight: visible.length ? Math.min(...visible.map(l => Math.round(l.getBoundingClientRect().height))) : null,
          minTargetWidth: visible.length ? Math.min(...visible.map(l => Math.round(l.getBoundingClientRect().width))) : null,
          gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : null
        });
      })()`, returnByValue: true,
    }, S);
    results.push({ section: name, width, ...JSON.parse(ev.result.value) });
  }
}
ws.close(); chrome.kill("SIGKILL");

const overflow = results.filter((r) => r.scrollWidth > r.width);
const lines = [];
lines.push("# Task 30.3 — real-browser width pass\n");
lines.push(`Measured in headless Chrome over CDP. ${Object.keys(sections).length} sections x ${WIDTHS.length} widths = ${results.length} measurements.\n`);
lines.push(`## Horizontal overflow (scrollWidth > width)\n\n**${overflow.length} of ${results.length}**\n`);
if (overflow.length) {
  lines.push("| section | width | scrollWidth | overflow |");
  lines.push("|---|---|---|---|");
  for (const r of overflow) lines.push(`| ${r.section} | ${r.width} | ${r.scrollWidth} | +${r.scrollWidth - r.width} |`);
  lines.push("");
}
lines.push("## Bottom bar: fixed below 750, released at 768\n");
lines.push("| width | position | visible targets | min target h x w |");
lines.push("|---|---|---|---|");
for (const w of WIDTHS) {
  const r = results.find((x) => x.width === w && x.section === "overview");
  if (r) lines.push(`| ${w} | ${r.barPosition} | ${r.visibleTargets} | ${r.minTargetHeight} x ${r.minTargetWidth} |`);
}
lines.push("");
lines.push("## Wishlist grid columns (1-up below 390, 2-up at 390)\n");
lines.push("| width | columns |");
lines.push("|---|---|");
for (const w of WIDTHS) {
  const r = results.find((x) => x.width === w && x.section === "wishlist");
  if (r) lines.push(`| ${w} | ${r.gridColumns ?? "no grid element in fixture"} |`);
}
lines.push("\n## Not covered here\n");
lines.push("- The live storefront render (needs an authenticated preview session).");
lines.push("- The mobile-keyboard case of 30.3 (needs a real device).");
writeFileSync(join(HERE, "..", "..", "..", "docs", "ops", "portal-30-3-width-pass.md"), lines.join("\n") + "\n", "utf8");

console.log(`measurements: ${results.length}`);
console.log(`overflow failures: ${overflow.length}`);
for (const r of overflow.slice(0, 12)) console.log(`  OVERFLOW ${r.section} @${r.width}: scrollWidth ${r.scrollWidth}`);
console.log("report: docs/ops/portal-30-3-width-pass.md");
process.exit(overflow.length === 0 ? 0 : 1);

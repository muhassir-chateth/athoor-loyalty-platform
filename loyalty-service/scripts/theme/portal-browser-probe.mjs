#!/usr/bin/env node
/**
 * portal-browser-probe.mjs — real-browser probe over the Chrome DevTools Protocol.
 *
 * -- WHY THIS EXISTS, AND WHY IT ADDS NO DEPENDENCY --------------------------
 * Tasks 30.3 and 30.5 need a real layout engine; 30.2 explicitly refuses jsdom as
 * evidence. But task 29.10 pins the dependency set (only `esbuild` and `axe-core` were
 * permitted) and task 33 requires `npm ls --omit=dev` to stay unchanged with
 * NEW RECURRING COST = £0/MONTH. Playwright or Puppeteer would breach both.
 *
 * Node 22+ ships a global `WebSocket`, and macOS already has Chrome. That is enough to
 * drive a real browser over CDP with NOTHING added to package.json.
 * `portalBrowserProbe.test.ts` asserts every import is a `node:` built-in, so this file
 * cannot quietly acquire a dependency later.
 *
 * -- WHAT IT CANNOT DO ------------------------------------------------------
 * It runs a throwaway profile (`/tmp/cdp-profile-throwaway`) and never touches the
 * owner's Chrome profile, so it holds no Shopify admin session and no customer session.
 * It therefore cannot perform the 30.2 authenticated journey: that is blocked on
 * credentials and an email inbox, not on tooling.
 *
 * First finding: on the live storefront `window.fbq` is undefined with zero
 * facebook/fbcdn requests out of 237, while `webPixelsManager` IS present — so Shopify's
 * Customer Events runtime is active and no Meta pixel is registered. Curl cannot see
 * either fact, because Customer Events pixels are injected at runtime.
 *
 * USAGE: node portal-browser-probe.mjs <url> [width] [height]
 */
import { spawn } from "node:child_process";
const BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const URL_TO_LOAD = process.argv[2];
const WIDTH = Number(process.argv[3] ?? 1280);
const HEIGHT = Number(process.argv[4] ?? 900);

const chrome = spawn(BIN, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/cdp-profile-throwaway",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function browserWs() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugger socket");
}

const ws = new WebSocket(await browserWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) =>
  new Promise((res) => { id += 1; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const { result: t } = await send("Target.createTarget", { url: "about:blank" });
const { result: a } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const S = a.sessionId;
await send("Network.enable", {}, S);
await send("Page.enable", {}, S);
await send("Emulation.setDeviceMetricsOverride",
  { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH < 750 }, S);
await send("Page.navigate", { url: URL_TO_LOAD }, S);
await sleep(9000);

const requests = events
  .filter((e) => e.method === "Network.requestWillBeSent")
  .map((e) => e.params.request.url);

const { result: ev } = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    fbq: typeof window.fbq,
    fbevents: !!document.querySelector('script[src*="connect.facebook.net"]'),
    webPixelsManager: typeof window.webPixelsManager,
    shopifyAnalytics: typeof window.ShopifyAnalytics,
    trekkie: typeof window.trekkie,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    portalRoot: !!document.querySelector('[data-portal-root]'),
    title: document.title.slice(0,60)
  })`, returnByValue: true,
}, S);

console.log(JSON.stringify({
  url: URL_TO_LOAD, viewport: `${WIDTH}x${HEIGHT}`,
  page: JSON.parse(ev.result.value),
  totalRequests: requests.length,
  facebook: requests.filter((u) => /facebook|fbcdn|fbevents/i.test(u)),
  webPixels: requests.filter((u) => /web-pixels|pixel/i.test(u)).slice(0, 8),
  analytics: requests.filter((u) => /trekkie|monorail|shopify-analytics/i.test(u)).slice(0, 5),
}, null, 2));
ws.close(); chrome.kill("SIGKILL");

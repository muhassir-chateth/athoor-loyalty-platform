// @vitest-environment jsdom
import { readFileSync } from "fs";
import { join } from "path";
import { it, expect } from "vitest";

// Use import.meta.dirname (Node 20.11+) instead of fileURLToPath
const __dirname = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
it("can read file from import.meta.dirname", () => {
  console.log("dirname =", __dirname);
  const p = join(__dirname, "..", "..", "..", "theme", "assets", "athoor-loyalty.js");
  const src = readFileSync(p, "utf8");
  expect(src).toContain("reconcileWishlistOnce");
});

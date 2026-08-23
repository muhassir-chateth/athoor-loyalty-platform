// @vitest-environment jsdom
import { fileURLToPath } from "url";
import { dirname } from "path";
import { readFileSync } from "fs";
import { it, expect } from "vitest";
it("fileURLToPath works", () => {
  const d = dirname(fileURLToPath(import.meta.url));
  console.log("dirname =", d);
  expect(d).toContain("src/theme");
});

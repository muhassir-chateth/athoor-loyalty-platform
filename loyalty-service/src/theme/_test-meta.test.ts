// @vitest-environment jsdom
import { it } from "vitest";
it("check import.meta", () => {
  console.log("import.meta.url =", import.meta.url);
});

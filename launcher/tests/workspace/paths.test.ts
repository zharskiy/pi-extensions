import { describe, expect, it } from "vitest";
import { byDepth } from "../../workspace/index.ts";

describe("byDepth", () => {
  it("orders by depth, then by code unit, whatever the locale", () => {
    expect(["/w/ö", "/w/z/deep", "/w/aa", "/w/B", "/w/z"].sort(byDepth)).toEqual([
      "/w/B",
      "/w/aa",
      "/w/z",
      "/w/ö",
      "/w/z/deep",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../adapter/contract.ts";
import {
  cacheHitPercent,
  cachePercentText,
  cacheTone,
  reportedCache,
  sessionCacheHit,
} from "../../manager/cache.ts";
import { plainTheme } from "../helpers/fakes.ts";

const tokenTheme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

describe("cache hit", () => {
  it("is the cache read share of the whole prompt, input, reads and writes", () => {
    expect(cacheHitPercent({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(80);
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it("stays unknown until the usage reports cache reads or writes", () => {
    expect(reportedCache({ input: 100, cacheRead: 0, cacheWrite: 0 })).toBe(false);
    expect(sessionCacheHit({ input: 100, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(sessionCacheHit({ input: 50, cacheRead: 0, cacheWrite: 50 })).toBe(0);
  });

  it("colours 70 and above as success, 30 to 70 as warning and below 30 as error", () => {
    expect([100, 70, 69.9, 30, 29.9, 0].map(cacheTone)).toEqual([
      "success",
      "success",
      "warning",
      "warning",
      "error",
      "error",
    ]);
  });

  it("prints the rounded percentage in the colour of its rate", () => {
    expect([91.4, 69.5, 12].map((percent) => cachePercentText(tokenTheme, percent))).toEqual([
      "<success>91%",
      "<warning>70%",
      "<error>12%",
    ]);
  });
});

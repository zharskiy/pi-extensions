import { describe, expect, it } from "vitest";
import { thresholdsFor } from "../handoff-limits.ts";

const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

describe("thresholdsFor", () => {
  it("caps the thresholds by tokens on a large window", () => {
    expect(thresholdsFor(1_000_000, limits)).toEqual({ soft: 125_000, hard: 175_000 });
  });

  it("keeps the ratios when they are below the caps", () => {
    expect(thresholdsFor(200_000, limits)).toEqual({ soft: 90_000, hard: 120_000 });
  });
});

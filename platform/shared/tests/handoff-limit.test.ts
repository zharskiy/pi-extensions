import { describe, expect, it } from "vitest";
import { limitLevel, mainLimit } from "../handoff/handoff-limit.ts";

const limit = { request: 100_000, warn: 80_000 };

describe("limit level", () => {
  it("is unknown without tokens or a limit", () => {
    expect(limitLevel(null, limit)).toBe("unknown");
    expect(limitLevel(10, undefined)).toBe("unknown");
  });

  it("goes normal, soft and hard as tokens grow", () => {
    expect(limitLevel(79_999, limit)).toBe("normal");
    expect(limitLevel(80_000, limit)).toBe("soft");
    expect(limitLevel(100_000, limit)).toBe("hard");
  });
});

const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

describe("mainLimit", () => {
  it("requests at the hard threshold and warns at the soft one", () => {
    expect(mainLimit(200_000, limits)).toEqual({ request: 120_000, warn: 90_000 });
  });

  it("caps the thresholds by tokens on a large window", () => {
    expect(mainLimit(1_000_000, limits)).toEqual({ request: 175_000, warn: 125_000 });
  });

  it("keeps the ratios when they are below the caps", () => {
    expect(mainLimit(100_000, limits)).toEqual({ request: 60_000, warn: 45_000 });
  });

  it("puts the warn line above the request line when the soft threshold is above the hard one", () => {
    const inverted = { ...limits, softRatio: 0.9, hardRatio: 0.75 };

    expect(limitLevel(80_000, mainLimit(100_000, inverted))).toBe("hard");
    expect(limitLevel(70_000, mainLimit(100_000, inverted))).toBe("normal");
  });

  it("is undefined for an unknown window", () => {
    expect(mainLimit(0, limits)).toBeUndefined();
  });
});

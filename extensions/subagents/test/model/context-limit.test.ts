import { describe, expect, it } from "vitest";
import { effectiveContextLimit } from "../../src/model/context-limit.ts";

describe("effective context limit", () => {
  it("uses the declared limit unless the model window minus the reserve is smaller", () => {
    expect(effectiveContextLimit(100_000, 400_000, 16_384)).toBe(100_000);
    expect(effectiveContextLimit(100_000, 64_000, 16_384)).toBe(47_616);
    expect(effectiveContextLimit(300_000, 200_000, 16_000)).toBe(184_000);
  });

  it("keeps the declared limit when the model window is unknown", () => {
    expect(effectiveContextLimit(100_000, 0, 16_000)).toBe(100_000);
  });
});

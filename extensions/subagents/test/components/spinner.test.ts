import { describe, expect, it } from "vitest";
import { spinnerFrame } from "../../src/components/spinner.ts";

describe("spinner", () => {
  it("picks the frame from the wall clock", () => {
    expect(spinnerFrame(0)).toBe("⠋");
    expect(spinnerFrame(250)).toBe("⠹");
    expect(spinnerFrame(1_000)).toBe("⠋");
    expect(spinnerFrame(950)).toBe("⠏");
  });
});

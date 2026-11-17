import { describe, expect, it } from "vitest";
import { initialIndex, numberProblem, toggle, warningFor } from "../../../cli/prompt/rules.ts";

describe("numberProblem", () => {
  const spec = { initial: 8, min: 1, max: 12, tooLow: "low", tooHigh: "high" };

  it("names the first problem of a typed number", () => {
    expect(numberProblem(spec, "")).toBe("Type a number.");

    expect(numberProblem(spec, "-1")).toBe("Type a whole number, like 8.");

    expect(numberProblem(spec, "0")).toBe("low");

    expect(numberProblem(spec, "13")).toBe("high");

    expect(numberProblem(spec, "012")).toBeUndefined();

    expect(numberProblem({ ...spec, tooHigh: undefined }, "13")).toBe("low");
  });
});

describe("warningFor", () => {
  const spec = { warn: (value: number) => (value > 24 ? "little memory left" : undefined) };

  it("warns about a value once and accepts it when entered again", () => {
    expect(warningFor(spec, 26, undefined)).toBe("little memory left");

    expect(warningFor(spec, 26, 26)).toBeUndefined();

    expect(warningFor(spec, 28, 26)).toBe("little memory left");

    expect(warningFor({}, 26, undefined)).toBeUndefined();
  });
});

describe("initialIndex", () => {
  const choices = ["a", "b", "c"].map((value) => ({ value, label: value }));

  it("starts at the initial value, or at the first choice when it is missing", () => {
    expect(initialIndex(choices, "c")).toBe(2);

    expect(initialIndex(choices, "x")).toBe(0);

    expect(initialIndex(choices, undefined)).toBe(0);
  });
});

describe("toggle", () => {
  it("flips a value in and out of the set", () => {
    const checked = new Set(["a"]);

    toggle(checked, "a");

    toggle(checked, "b");

    expect([...checked]).toEqual(["b"]);
  });
});

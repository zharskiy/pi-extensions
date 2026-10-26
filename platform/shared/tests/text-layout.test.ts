import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../test/framework/index.ts";
import { fixedBlock, padRows } from "../text/text-layout.ts";

describe("padRows", () => {
  it("pads short input with blank rows and cuts long input", () => {
    expect(padRows(["a"], 3)).toEqual(["a", "", ""]);
    expect(padRows(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(padRows([], 0)).toEqual([]);
  });
});

describe("fixedBlock", () => {
  it("pads text that needs fewer rows with blank rows", () => {
    expect(fixedBlock(plainTheme, "alpha beta", 12, 3)).toEqual(["alpha beta", "", ""]);
  });

  it("returns only the rows when the text fills them exactly", () => {
    expect(fixedBlock(plainTheme, "alpha beta gamma", 10, 2)).toEqual(["alpha beta", "gamma"]);
  });

  it("cuts the last row with an ellipsis when text remains", () => {
    expect(fixedBlock(plainTheme, "alpha beta gamma delta epsilon", 10, 2)).toEqual([
      "alpha beta",
      "gamma...",
    ]);
  });

  it("keeps the ellipsis inside the width", () => {
    const [, last] = fixedBlock(plainTheme, "alpha beta gammadelta epsilon", 10, 2);

    expect(last).toBe("gammade...");
    expect(last?.length).toBeLessThanOrEqual(10);
  });

  it("gives blank rows for empty text", () => {
    expect(fixedBlock(plainTheme, "", 10, 2)).toEqual(["", ""]);
  });
});

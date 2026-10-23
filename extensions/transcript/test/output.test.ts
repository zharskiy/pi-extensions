import { describe, expect, it } from "vitest";
import type { ThemeLike, ThemeToken } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { moreLine, truncatedOutput } from "../src/output.ts";

const numbered = (count: number) =>
  Array.from({ length: count }, (_value, index) => `line ${index + 1}`).join("\n");

describe("truncatedOutput", () => {
  it.each([
    [0, "head", [], 0],
    [3, "head", ["line 1", "line 2", "line 3"], 0],
    [10, "head", ["line 1", "line 2", "line 3"], 7],
    [10, "tail", ["line 8", "line 9", "line 10"], 7],
    [3, "tail", ["line 1", "line 2", "line 3"], 0],
  ] as const)("keeps %i lines by %s", (count, keep, lines, hidden) => {
    expect(truncatedOutput(numbered(count), 3, keep)).toEqual({ lines, hidden });
  });
});

describe("moreLine", () => {
  it("names the hidden lines in the dim colour", () => {
    const painted: ThemeToken[] = [];
    const theme: ThemeLike = {
      ...plainTheme,
      fg: (token, text) => {
        painted.push(token);
        return text;
      },
    };

    expect(moreLine(7, theme)).toBe("… +7 lines");
    expect(moreLine(1, theme)).toBe("… +1 line");
    expect(painted).toEqual(["dim", "dim"]);
  });
});

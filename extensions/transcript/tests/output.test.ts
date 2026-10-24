import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../test-framework/index.ts";
import { errorRows, outputLines, previewRows, shellResult } from "../ui/output.ts";
import { numbered } from "./support/transcript-rows.ts";

describe("outputLines", () => {
  it("drops trailing blank lines, expands tabs and removes control characters", () => {
    expect(outputLines("")).toEqual([]);
    expect(outputLines("a\n\tb\r\n\n")).toEqual(["a", "   b"]);
    expect(outputLines(`${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[39m`)).toEqual(["red"]);
  });
});

describe("shellResult", () => {
  it.each([
    ["out\n\nCommand exited with code 2", "out", "exit 2", false],
    ["out\n\nCommand timed out after 30 seconds", "out", "timed out after 30s", true],
    ["out\n\nCommand aborted", "out", "stopped", false],
    ["Command exited with code 1", "", "exit 1", false],
  ] as const)("strips pi's status line from %j", (text, output, reason, timedOut) => {
    expect(shellResult(text)).toEqual({ output, reason, timedOut });
  });

  it("leaves output without a status line alone", () => {
    expect(shellResult("a\nb")).toEqual({ output: "a\nb", timedOut: false });
  });
});

describe("previewRows", () => {
  const spec = { token: "muted", room: 60, key: "ctrl+o" } as const;

  it("keeps the head with pi's more-lines count line after it", () => {
    expect(previewRows(outputLines(numbered(10, "line")), { ...spec, keep: "head" }, plainTheme)).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "... (7 more lines, ctrl+o to expand)",
    ]);
  });

  it("keeps the tail with pi's earlier-lines count line before it, in the singular for one", () => {
    expect(previewRows(outputLines(numbered(4, "line")), { ...spec, keep: "tail" }, plainTheme)).toEqual([
      "... (1 earlier line, ctrl+o to expand)",
      "line 2",
      "line 3",
      "line 4",
    ]);
  });

  it("drops only the key when the count line has no room", () => {
    expect(
      previewRows(outputLines(numbered(10, "line")), { ...spec, keep: "head", room: 24 }, plainTheme).at(-1),
    ).toBe("... (7 more lines)");
  });
});

describe("errorRows", () => {
  it("shows three visual rows, or two and a count of the lines not fully shown", () => {
    expect(errorRows(["a", "b", "c"], 40, "ctrl+o", plainTheme)).toEqual(["a", "b", "c"]);
    expect(errorRows(["a", "b", "c", "d"], 40, "ctrl+o", plainTheme)).toEqual([
      "a",
      "b",
      "... (2 more lines, ctrl+o to expand)",
    ]);
    expect(errorRows(["aaaa bbbb cccc", "d"], 4, "", plainTheme)).toEqual(["aaaa", "bbbb", "...."]);
    expect(errorRows(["aaaa bbbb cccc", "d"], 20, "ctrl+o", plainTheme)).toEqual(["aaaa bbbb cccc", "d"]);
  });
});

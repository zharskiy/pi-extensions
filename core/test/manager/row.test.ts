import { describe, expect, it } from "vitest";
import type { ThemeLike, ThemeToken } from "../../adapter/contract.ts";
import { childRow, expandHint, type RowState, rowText, toolRow, toolState } from "../../manager/row.ts";
import { plainTheme } from "../helpers/fakes.ts";

const recordingTheme = () => {
  const painted: { token: ThemeToken; text: string }[] = [];
  const theme: ThemeLike = {
    ...plainTheme,
    fg: (token, text) => {
      painted.push({ token, text });
      return text;
    },
  };

  return { theme, painted };
};

const tokenOf = (painted: { token: ThemeToken; text: string }[], text: string) =>
  painted.find((entry) => entry.text === text)?.token;

describe("toolRow", () => {
  it.each<[RowState, ThemeToken]>([
    ["pending", "dim"],
    ["success", "success"],
    ["error", "error"],
    ["text", "text"],
  ])("paints the %s bullet with %s", (state, token) => {
    const { theme, painted } = recordingTheme();

    expect(toolRow({ state, title: "Read a.ts" })(40, theme)).toEqual(["● Read a.ts"]);
    expect(tokenOf(painted, "●")).toBe(token);
  });

  it("cuts a long title to one line with an ellipsis", () => {
    const lines = toolRow({ state: "success", title: "x".repeat(50) })(20, plainTheme);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("…")).toBe(true);
    expect(plainTheme.width(lines[0] ?? "")).toBe(20);
  });

  it("starts child continuation lines at the column of the child's first text", () => {
    const { theme, painted } = recordingTheme();
    const [title, first, second] = toolRow({ state: "success", title: "Bash", children: ["one\ntwo"] })(
      40,
      theme,
    );

    expect(title).toBe("● Bash");
    expect(first?.trimStart().startsWith("⎿")).toBe(true);
    expect(first?.indexOf("one")).toBe(second?.indexOf("two"));
    expect(second?.trim()).toBe("two");
    expect(tokenOf(painted, "⎿")).toBe("dim");
  });

  it("appends the hint to the last child line, or to the title when there is none", () => {
    const hint = (theme: ThemeLike) => expandHint("ctrl+o", theme);

    expect(toolRow({ state: "success", title: "Edit", children: ["a", "b"], hint })(40, plainTheme)).toEqual([
      "● Edit",
      "  ⎿  a",
      "     b (ctrl+o expand)",
    ]);
    expect(toolRow({ state: "success", title: "Read", hint })(40, plainTheme)).toEqual([
      "● Read (ctrl+o expand)",
    ]);
  });

  it("drops the hint rather than cut the line it follows", () => {
    const [line] = toolRow({ state: "success", title: "y".repeat(60), hint: "(k expand)" })(40, plainTheme);

    expect(line).toBe(`● ${"y".repeat(37)}…`);
    expect(plainTheme.width(line ?? "")).toBe(40);
  });

  it("keeps the hint when the line and the hint fit exactly", () => {
    const title = "y".repeat(27);
    const [line] = toolRow({ state: "success", title, hint: "(k expand)" })(40, plainTheme);

    expect(line).toBe(`● ${title} (k expand)`);
  });

  it.each([20, 80, 200])("draws no line wider than %i columns", (width) => {
    const long = "word ".repeat(80);
    const lines = toolRow({ state: "error", title: long, children: [long, long], hint: "(k expand)" })(
      width,
      plainTheme,
    );

    expect(lines.every((line) => plainTheme.width(line) <= width)).toBe(true);
  });
});

describe("childRow", () => {
  it("draws only the child lines", () => {
    expect(childRow({ children: ["Read 3 lines"] })(40, plainTheme)).toEqual(["  ⎿  Read 3 lines"]);
    expect(childRow({})(40, plainTheme)).toEqual([]);
  });
});

describe("toolState", () => {
  it("is pending until started and while partial, then error or success", () => {
    expect(toolState({ started: false, isPartial: false, isError: false })).toBe("pending");
    expect(toolState({ isPartial: true, isError: true })).toBe("pending");
    expect(toolState({ isPartial: false, isError: true })).toBe("error");
    expect(toolState({ started: true, isPartial: false, isError: false })).toBe("success");
  });
});

describe("rowText", () => {
  it("joins a row's lines for a width-function tool render", () => {
    expect(rowText(toolRow({ state: "success", title: "Run", children: ["ok"] }), plainTheme)(40)).toBe(
      "● Run\n  ⎿  ok",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  piEditDiff,
  renderExpandedEdit,
  renderPaneEdit,
  renderPaneTool,
  renderTool,
  visible,
} from "../../../core/test/adapter/tool-rows.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { parseDiff } from "../src/diff.ts";
import { transcriptRows } from "../src/tools.ts";

const rows = transcriptRows(() => "ctrl+o", "/home/me");

const diff = "  1 keep\n- 2 let total = 1;\n+ 2 let total = 2;\n+ 3 log(total);\n    ...\n 30 tail";

const ESC = String.fromCharCode(27);

const numbered = (count: number) =>
  Array.from({ length: count }, (_value, index) => `out ${index + 1}`).join("\n");

describe("diff rows through pi", () => {
  it("parses the diff pi's edit tool returns", async () => {
    const lines = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`);
    const edited = await piEditDiff(`${lines.join("\n")}\n`, [
      { oldText: "line 2\n", newText: "line 2 changed\n" },
      { oldText: "line 18\n", newText: "line 18 changed\n" },
    ]);

    expect(parseDiff(edited)?.map((line) => line.kind)).toContain("gap");
  });

  it("hangs the drawn diff at column 4 after pi's output pad, under the ↳ summary", () => {
    const shown = (outputPad: number) =>
      renderExpandedEdit(rows, { diff, outputPad, width: 40 }).map((line) => visible(line).trimEnd());

    expect(shown(1)).toEqual([
      "   ↳ Added 2 lines, removed 1 line",
      "       1 keep",
      "     - 2 let total = 1;",
      "     + 2 let total = 2;",
      "     + 3 log(total);",
      "     ...",
      "      30 tail",
    ]);
    expect(shown(0).slice(0, 2)).toEqual(["  ↳ Added 2 lines, removed 1 line", "      1 keep"]);
  });

  it("fills every changed row to the width on pi's dark theme without dropping the background early", () => {
    const changed = renderExpandedEdit(rows, { diff, outputPad: 1, width: 40 }).slice(2, 5);

    changed.forEach((line) => {
      const gaps = line.split(`${ESC}[49m`).slice(1, -1);

      expect(plainTheme.width(line)).toBe(40);
      expect(gaps.every((rest) => rest.startsWith(`${ESC}[48;`))).toBe(true);
    });
  });

  it("wraps a long changed line on pi's dark theme with the background on every row", () => {
    const long =
      "- 1 let total = sum(values[1:]) if values else 0\n+ 1 let total = sum(values) if values else 0";
    const drawn = renderExpandedEdit(rows, { diff: long, outputPad: 1, width: 40 }).slice(1);

    expect(drawn.map((line) => visible(line).trimEnd())).toEqual([
      "     -1 let total = sum(values[1:]) if",
      "        values else 0",
      "     +1 let total = sum(values) if",
      "        values else 0",
    ]);
    drawn.forEach((line) => {
      expect(plainTheme.width(line)).toBe(40);
      expect(line.slice(line.indexOf(ESC))).toMatch(new RegExp(`^${ESC}\\[48;`));
    });
  });

  it("falls back to pi's foreground diff look on a theme without panels", () => {
    const long =
      "- 1 let total = sum(values[1:]) if values else 0\n+ 1 let total = sum(values) if values else 0";
    const { painted, lines } = renderTool(rows, {
      name: "edit",
      args: { path: "/repo/a.ts" },
      result: "ok",
      details: { diff: long },
      expanded: true,
      width: 40,
    });

    expect(lines.map((line) => line.trimEnd())).toEqual([
      " ✓ Edit a.ts",
      "   ↳ Added 1 line, removed 1 line",
      "     -1 let total = sum(values[1:]) if",
      "        values else 0",
      "     +1 let total = sum(values) if",
      "        values else 0",
    ]);
    painted.slice(2).forEach((line) => {
      expect(line).not.toContain(`${ESC}[48;`);
      expect(line).toContain(`${ESC}[38;`);
    });
  });

  it("draws an expanded edit in the agent view's transcript", () => {
    const text = renderPaneEdit(rows, "-1 old line\n+1 new line", 60).join("\n");

    expect(text).toContain(" ✓ Edit a.ts\n   ↳ Added 1 line, removed 1 line\n     -1 old line");
    expect(text).toContain("     +1 new line");
  });
});

describe("pi's bodies under the rows", () => {
  it("hangs pi's read body at column 4 under the line count", () => {
    const { lines } = renderTool(rows, {
      name: "read",
      args: { path: "/repo/a.ts" },
      result: numbered(10),
      expanded: true,
      width: 80,
    });

    expect(lines.slice(0, 4).map((line) => line.trimEnd())).toEqual([
      " ✓ Read a.ts",
      "   ↳ 10 lines",
      "     out 1",
      "     out 2",
    ]);
  });

  it("hangs pi's bash body at column 4 without its timing line, the duration on the title", () => {
    const { lines } = renderTool(rows, {
      name: "bash",
      args: { command: "ls" },
      result: numbered(5),
      expanded: true,
      durationMs: 6000,
      width: 80,
    });

    expect(lines.map((line) => line.trimEnd()).filter((line) => line !== "")).toEqual([
      " ✓ $ ls · 6s",
      "   ↳ out 1",
      "     out 2",
      "     out 3",
      "     out 4",
      "     out 5",
    ]);
  });

  it("keeps every rendered line within the width at 40 and 12 columns", () => {
    const inputs = [
      { name: "read", args: { path: "/repo/src/auth/middleware/session.ts" }, result: numbered(10) },
      {
        name: "bash",
        args: { command: "npm test -- --run" },
        result: `${numbered(9)}\n\nCommand exited with code 1`,
        isError: true,
      },
      { name: "edit", args: { path: "/repo/a.ts" }, result: "ok", details: { diff }, expanded: true },
      { name: "grep", args: { pattern: "TODO", path: "/repo/src" }, result: numbered(4), expanded: true },
    ];

    [40, 12].forEach((width) => {
      inputs.forEach((input) => {
        renderTool(rows, { ...input, width }).painted.forEach((line) => {
          expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
        });
      });
    });
  });
});

describe("finished rows pi replays without a start", () => {
  const trimmed = (lines: string[]) => lines.map((line) => line.trimEnd());

  it("marks a resumed read and bash done", () => {
    expect(
      trimmed(
        renderTool(rows, {
          name: "read",
          args: { path: "/repo/a.ts" },
          result: "one\ntwo",
          durationMs: 7_000,
          started: false,
          width: 60,
        }).lines,
      ),
    ).toEqual([" ✓ Read a.ts · 7s", "   ↳ 2 lines"]);
    expect(
      trimmed(
        renderTool(rows, {
          name: "bash",
          args: { command: "ls" },
          result: "a.ts",
          durationMs: 7_000,
          started: false,
          width: 60,
        }).lines,
      ),
    ).toEqual([" ✓ $ ls · 7s", "   ↳ a.ts"]);
  });

  it("marks a call of an aborted turn stopped, without pi's abort text as output", () => {
    expect(
      trimmed(
        renderTool(rows, {
          name: "bash",
          args: { command: "npm run dev" },
          result: "Operation aborted",
          isError: true,
          started: false,
          width: 60,
        }).lines,
      ),
    ).toEqual([" ⊘ $ npm run dev · stopped"]);
  });

  it("marks a call of a failed turn failed", () => {
    expect(
      renderTool(rows, {
        name: "read",
        args: { path: "/repo/a.ts" },
        result: "Error",
        isError: true,
        started: false,
        width: 60,
      }).lines[0]?.trimEnd(),
    ).toBe(" ✗ Read a.ts · Error");
  });

  it("marks the open calls of an aborted or failed agent turn stopped or failed in the pane", () => {
    expect(
      trimmed(
        renderPaneTool(rows, {
          name: "bash",
          args: { command: "npm run dev" },
          stopReason: "aborted",
          width: 60,
        }),
      ),
    ).toEqual([" ⊘ $ npm run dev · stopped"]);
    expect(
      renderPaneTool(rows, {
        name: "read",
        args: { path: "/repo/a.ts" },
        stopReason: "error",
        width: 60,
      })[0]?.trimEnd(),
    ).toBe(" ✗ Read a.ts · Error");
  });
});

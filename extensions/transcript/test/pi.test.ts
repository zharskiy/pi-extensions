import { describe, expect, it } from "vitest";
import {
  piEditDiff,
  renderExpandedEdit,
  renderPaneEdit,
  visible,
} from "../../../core/test/adapter/tool-rows.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { parseDiff } from "../src/diff.ts";
import { transcriptRows } from "../src/tools.ts";

const rows = transcriptRows(() => "ctrl+o", "/home/me");

const diff = "  1 keep\n- 2 let total = 1;\n+ 2 let total = 2;\n+ 3 log(total);\n    ...\n 30 tail";

const ESC = String.fromCharCode(27);

describe("diff rows through pi", () => {
  it("parses the diff pi's edit tool returns", async () => {
    const lines = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`);
    const edited = await piEditDiff(`${lines.join("\n")}\n`, [
      { oldText: "line 2\n", newText: "line 2 changed\n" },
      { oldText: "line 18\n", newText: "line 18 changed\n" },
    ]);

    expect(parseDiff(edited)?.map((line) => line.kind)).toContain("gap");
  });

  it("hangs the drawn diff five columns after pi's output pad", () => {
    const shown = (outputPad: number) =>
      renderExpandedEdit(rows, { diff, outputPad, width: 40 }).map((line) => visible(line).trimEnd());

    expect(shown(1)).toEqual([
      "   ⎿  Added 2 lines, removed 1 line",
      "       1   keep",
      "       2 - let total = 1;",
      "       2 + let total = 2;",
      "       3 + log(total);",
      "           ...",
      "      30   tail",
    ]);
    expect(shown(0).slice(0, 2)).toEqual(["  ⎿  Added 2 lines, removed 1 line", "      1   keep"]);
  });

  it("fills every changed row to the width on pi's theme without dropping the background early", () => {
    const changed = renderExpandedEdit(rows, { diff, outputPad: 1, width: 40 }).slice(2, 5);

    changed.forEach((line) => {
      const gaps = line.split(`${ESC}[49m`).slice(1, -1);

      expect(plainTheme.width(line)).toBe(40);
      expect(gaps.every((rest) => rest.startsWith(`${ESC}[48;`))).toBe(true);
    });
  });

  it("draws an expanded edit in the agent view's transcript", () => {
    const text = renderPaneEdit(rows, "-1 old line\n+1 new line", 60).join("\n");

    expect(text).toContain(" ● Update a.ts\n   ⎿  Added 1 line, removed 1 line\n      1 - old line");
    expect(text).toContain("      1 + new line");
  });
});

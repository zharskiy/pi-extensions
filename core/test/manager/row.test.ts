import { describe, expect, it } from "vitest";
import type { ThemeLike, ThemeToken } from "../../../pi-adapter/index.ts";
import { appendHint, countLine, expandHint } from "../../manager/hints.ts";
import { cutStart } from "../../manager/layout.ts";
import { MARKS, type Mark } from "../../manager/marks.ts";
import {
  CHILD_COLUMN,
  failureSuffix,
  type MarkedRow,
  preview,
  row,
  rowChildren,
  type TitleParts,
  titleLine,
  wrapChild,
} from "../../manager/row.ts";
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

const read = (patch: Partial<TitleParts> = {}): Omit<TitleParts, "mark"> => ({
  verb: "Read",
  target: { text: "src/auth/session.ts", cut: "start" },
  ...patch,
});

const at = (spec: MarkedRow, width: number, theme: ThemeLike = plainTheme) => row(spec)(width - 1, theme);

describe("row", () => {
  it("draws the five read states of S2 at 80 columns", () => {
    const enoent = "ENOENT: no such file or directory, access '/home/dev/proj/src/auth/sesion.ts'";

    expect(
      at(
        {
          mark: "success",
          title: read({ target: { text: "src/auth/session.ts", cut: "start", tail: ":5-14" } }),
          children: ["10 lines"],
        },
        80,
      ),
    ).toEqual(["✓ Read src/auth/session.ts:5-14", "  ↳ 10 lines"]);
    expect(at({ mark: "pending", title: { verb: "Read" } }, 80)).toEqual(["◌ Read"]);
    expect(at({ mark: "pending", title: read() }, 80)).toEqual(["◌ Read src/auth/session.ts"]);
    expect(
      at(
        {
          mark: "error",
          title: read({
            target: { text: "src/auth/sesion.ts", cut: "start" },
            reason: { text: "file not found" },
          }),
        },
        80,
      ),
    ).toEqual(["✗ Read src/auth/sesion.ts · file not found"]);
    expect(
      at(
        {
          mark: "error",
          title: read({ target: { text: "src/auth/sesion.ts", cut: "start" } }),
          children: [wrapChild(enoent, 79, CHILD_COLUMN, plainTheme).join("\n")],
        },
        80,
      ),
    ).toEqual([
      "✗ Read src/auth/sesion.ts",
      "  ↳ ENOENT: no such file or directory, access",
      "    '/home/dev/proj/src/auth/sesion.ts'",
    ]);
  });

  it("cuts a path at its start at 40 columns and keeps the range", () => {
    const title = read({ target: { text: "src/auth/middleware/session.ts", cut: "start", tail: ":5-14" } });

    expect(at({ mark: "success", title, children: ["10 lines"] }, 40)).toEqual([
      "✓ Read ...th/middleware/session.ts:5-14",
      "  ↳ 10 lines",
    ]);
  });

  it("keeps the edit hint at 80 columns and drops it at 40, where the summary fits alone (S3)", () => {
    const edit = (width: number) =>
      at(
        {
          mark: "success",
          title: { verb: "Edit", target: { text: "src/stats.py", cut: "start" } },
          children: ["Added 1 line, removed 1 line"],
          hint: expandHint("ctrl+o"),
          hintCuts: true,
        },
        width,
      );

    expect(edit(80)).toEqual(["✓ Edit src/stats.py", "  ↳ Added 1 line, removed 1 line (ctrl+o to expand)"]);
    expect(edit(40)).toEqual(["✓ Edit src/stats.py", "  ↳ Added 1 line, removed 1 line"]);
  });

  it("cuts a one-line summary to keep the hint while 20 columns of summary remain", () => {
    const summary =
      "This session continues the previous session /s/main.jsonl, which reached its context limit.";
    const seed = (width: number) =>
      at(
        {
          mark: "info",
          title: "Handoff from the previous session",
          children: [summary],
          hint: expandHint("ctrl+o"),
          hintCuts: true,
        },
        width,
      );

    expect(seed(80)[1]).toBe(
      "  ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)",
    );
    expect(seed(40)[1]).toBe("  ↳ This session continues the previ...");
  });

  it("wraps an error at column 4 under the ↳", () => {
    const error =
      "Could not find the exact text in src/stats.py. The old text must match exactly including all whitespace and newlines.";

    expect(
      at(
        {
          mark: "error",
          title: { verb: "Edit", target: { text: "src/stats.py", cut: "start" } },
          children: [wrapChild(error, 79, CHILD_COLUMN, plainTheme).join("\n")],
        },
        80,
      ),
    ).toEqual([
      "✗ Edit src/stats.py",
      "  ↳ Could not find the exact text in src/stats.py. The old text must match",
      "    exactly including all whitespace and newlines.",
    ]);
  });

  it("nests rows with the glyph at column 4, the text at 6 and the title's next line at 6", () => {
    const agent = (name: string, status: string): MarkedRow => ({
      mark: "pending",
      title: `${name}  Map the auth module · model-a:low\n${status}`,
    });

    expect(
      at(
        {
          mark: "pending",
          title: "3 background agents (↓ to manage, ← to list)",
          children: [agent("scout", "Running"), agent("worker", "Queued"), agent("reviewer", "Starting")],
        },
        80,
      ),
    ).toEqual([
      "◌ 3 background agents (↓ to manage, ← to list)",
      "  ↳ ◌ scout  Map the auth module · model-a:low",
      "      Running",
      "    ◌ worker  Map the auth module · model-a:low",
      "      Queued",
      "    ◌ reviewer  Map the auth module · model-a:low",
      "      Starting",
    ]);
  });

  it("keeps empty separator rows truly empty and hangs the body at column 4", () => {
    const lines = at(
      {
        mark: "success",
        title: "codemode",
        children: ["3 calls", "", "script"],
        body: () => ["const a = 1;", "", "✓ grep 12ms"],
      },
      80,
    );

    expect(lines).toEqual([
      "✓ codemode",
      "  ↳ 3 calls",
      "",
      "    script",
      "    const a = 1;",
      "",
      "    ✓ grep 12ms",
    ]);
  });

  it("paints each mark with its token and the ↳ dim", () => {
    const { theme, painted } = recordingTheme();
    const marks: [Mark, ThemeToken][] = [
      ["pending", "dim"],
      ["success", "success"],
      ["error", "error"],
      ["stopped", "muted"],
      ["info", "accent"],
    ];

    marks.forEach(([mark]) => {
      row({ mark, title: "x", children: ["y"] })(40, theme);
    });

    expect(marks.map(([mark]) => tokenOf(painted, MARKS[mark]))).toEqual(marks.map(([, token]) => token));
    expect(tokenOf(painted, "↳")).toBe("dim");
  });

  it("draws child lines alone with rowChildren", () => {
    expect(rowChildren({ children: ["10 lines"] })(40, plainTheme)).toEqual(["  ↳ 10 lines"]);
    expect(rowChildren({})(40, plainTheme)).toEqual([]);
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "draws no line wider than %i columns",
    (width) => {
      const long = "word ".repeat(20);
      const lines = row({
        mark: "error",
        title: read({ reason: { text: "file not found" }, duration: "12s" }),
        children: [long, { mark: "pending", title: long, children: [long] }, ""],
        hint: expandHint("ctrl+o"),
        hintCuts: true,
        body: () => [long],
      })(width, plainTheme);

      expect(lines.filter((line) => plainTheme.width(line) > width)).toEqual([]);
    },
  );
});

describe("titleLine", () => {
  const shell = (patch: Partial<TitleParts> = {}): TitleParts => ({
    mark: "error",
    verb: "$",
    target: { text: "npm test -- --run src/stats.test.ts", token: "text", cut: "end" },
    reason: { text: "exit 1" },
    duration: "9s",
    ...patch,
  });

  it("puts the reason, then the duration after the target", () => {
    expect(titleLine(shell(), 79, plainTheme)).toBe("✗ $ npm test -- --run src/stats.test.ts · exit 1 · 9s");
  });

  it("drops the duration first and keeps the reason while it cuts the target", () => {
    expect(titleLine(shell(), 53, plainTheme)).toBe("✗ $ npm test -- --run src/stats.test.ts · exit 1 · 9s");
    expect(titleLine(shell(), 52, plainTheme)).toBe("✗ $ npm test -- --run src/stats.test.ts · exit 1");
    expect(titleLine(shell(), 39, plainTheme)).toBe("✗ $ npm test -- --run src/s... · exit 1");
  });

  it("cuts arguments before the target", () => {
    const mcp: TitleParts = {
      mark: "success",
      target: { text: "notes/search", bold: true, cut: "end" },
      args: 'query="auth flow" limit=2 deep=true',
    };

    expect(titleLine(mcp, 79, plainTheme)).toBe('✓ notes/search query="auth flow" limit=2 deep=true');
    expect(titleLine(mcp, 39, plainTheme)).toBe('✓ notes/search query="auth flow" lim...');
  });

  it("cuts the target into the room left after the verb", () => {
    expect(titleLine({ ...read(), mark: "success" }, 12, plainTheme)).toBe("✓ Read ...ts");
  });

  it("paints the verb as given, the target in accent and the separators muted", () => {
    const { theme, painted } = recordingTheme();

    titleLine({ ...shell(), verb: (t) => t.fg("muted", "$") }, 79, theme);

    expect(tokenOf(painted, "$")).toBe("muted");
    expect(tokenOf(painted, "npm test -- --run src/stats.test.ts")).toBe("text");
    expect(tokenOf(painted, " · ")).toBe("muted");
    expect(tokenOf(painted, "exit 1")).toBe("error");
    expect(tokenOf(painted, "9s")).toBe("muted");
  });
});

describe("failureSuffix", () => {
  const title: TitleParts = {
    mark: "error",
    verb: "Read",
    target: { text: "src/auth/sesion.ts", cut: "start" },
  };

  it("keeps a short one-line reason for the title", () => {
    expect(failureSuffix("file not found", title, 79, plainTheme)).toBe("file not found");
  });

  it("sends long, multi-line or crowded reasons to the child line", () => {
    expect(failureSuffix("x".repeat(33), title, 79, plainTheme)).toBeUndefined();
    expect(failureSuffix("one\ntwo", title, 79, plainTheme)).toBeUndefined();
    expect(failureSuffix("file not found", title, 30, plainTheme)).toBeUndefined();
  });
});

describe("cutStart", () => {
  it("keeps the end of the text after an ASCII ellipsis, by graphemes", () => {
    expect(cutStart("src/auth/session.ts", 12, plainTheme)).toBe("...ession.ts");
    expect(cutStart("short", 10, plainTheme)).toBe("short");
    expect(cutStart("a/日本語.ts", 8, plainTheme)).toBe("...語.ts");
    expect(cutStart("abcdef", 2, plainTheme)).toBe("..");
  });
});

describe("expandHint", () => {
  it("names the key in pi's in-row form, all dim, and nothing when the key is unset", () => {
    const { theme, painted } = recordingTheme();
    const hint = expandHint("ctrl+o");

    expect(typeof hint === "function" ? hint(theme) : hint).toBe("(ctrl+o to expand)");
    expect(tokenOf(painted, "(ctrl+o to expand)")).toBe("dim");
    expect(expandHint("")).toBeUndefined();
  });
});

describe("appendHint", () => {
  it("appends the hint after one space when it fits, else keeps the line", () => {
    expect(appendHint("10 lines", "(k)", 20, plainTheme)).toBe("10 lines (k)");
    expect(appendHint("x".repeat(18), "(k)", 20, plainTheme)).toBe("x".repeat(18));
  });

  it("cuts a summary that must be cut anyway while 20 columns remain", () => {
    expect(appendHint("y".repeat(40), "(k)", 30, plainTheme, { cuttable: true })).toBe(
      `${"y".repeat(23)}... (k)`,
    );
    expect(appendHint("y".repeat(40), "(k)", 23, plainTheme, { cuttable: true })).toBe(
      `${"y".repeat(20)}...`,
    );
  });
});

describe("countLine", () => {
  it("uses pi's tool-renderer wording with the key", () => {
    expect(countLine({ hidden: 37, end: "more", noun: "line", key: "ctrl+o" }, 79, plainTheme)).toBe(
      "... (37 more lines, ctrl+o to expand)",
    );
    expect(countLine({ hidden: 1, end: "earlier", noun: "line", key: "ctrl+o" }, 79, plainTheme)).toBe(
      "... (1 earlier line, ctrl+o to expand)",
    );
    expect(countLine({ hidden: 24, end: "more", noun: "item", key: "ctrl+o" }, 79, plainTheme)).toBe(
      "... (24 more items, ctrl+o to expand)",
    );
  });

  it("drops only the key part when it is narrow or the key is unset", () => {
    expect(countLine({ hidden: 52, end: "earlier", noun: "line", key: "ctrl+o" }, 35, plainTheme)).toBe(
      "... (52 earlier lines)",
    );
    expect(countLine({ hidden: 52, end: "earlier", noun: "line" }, 79, plainTheme)).toBe(
      "... (52 earlier lines)",
    );
  });

  it("paints the words muted and the key dim", () => {
    const { theme, painted } = recordingTheme();

    countLine({ hidden: 2, end: "more", noun: "line", key: "ctrl+o" }, 79, theme);

    expect(painted).toEqual([
      { token: "muted", text: "... (2 more lines, " },
      { token: "dim", text: "ctrl+o" },
      { token: "muted", text: " to expand)" },
    ]);
  });
});

describe("preview", () => {
  it("keeps the head or the tail and counts the hidden lines", () => {
    const lines = ["1", "2", "3", "4", "5"];

    expect(preview(lines, { keep: "head" })).toEqual({ shown: ["1", "2", "3"], hidden: 2 });
    expect(preview(lines, { keep: "tail" })).toEqual({ shown: ["3", "4", "5"], hidden: 2 });
    expect(preview(["1"], { keep: "tail", max: 3 })).toEqual({ shown: ["1"], hidden: 0 });
  });
});

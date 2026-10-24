import { describe, expect, it } from "vitest";
import type { ThemeToken, ToolCallView } from "../../../platform/pi-adapter/index.ts";
import { paintRecordingTheme, plainTheme } from "../../../test/framework/index.ts";
import { diffCounts, parseDiff } from "../ui/diff.ts";
import { numbered, rows } from "./support/transcript-rows.ts";

const view = (name: string, args: unknown, patch: Partial<ToolCallView> = {}): ToolCallView => ({
  name,
  args,
  argsComplete: true,
  started: true,
  isPartial: false,
  isError: false,
  expanded: false,
  cwd: "/repo",
  aborted: false,
  ...patch,
});

const done = (text: string, patch: Partial<ToolCallView> = {}, details?: unknown): Partial<ToolCallView> => ({
  result: { text, details, isError: patch.isError, images: 0 },
  ...patch,
});

const draw = (input: ToolCallView, columns = 80) => {
  const { theme, painted, bolded } = paintRecordingTheme();
  const row = rows(input);
  const width = columns - 1;
  const lines = [...(row?.call(width, theme) ?? []), ...(row?.result?.(width, theme) ?? [])];

  return {
    lines: lines.map((line) => (line === "" ? "" : ` ${line}`)),
    painted,
    bolded,
    piBody: row?.piBody,
    dropTiming: row?.dropTiming,
  };
};

const tokenOf = (painted: { token: ThemeToken; text: string }[], text: string) =>
  painted.find((entry) => entry.text === text)?.token;

const enoent = "ENOENT: no such file or directory, access '/Users/me/proj/src/auth/sesion.ts'";

describe("S1 tool row states", () => {
  const read = (patch: Partial<ToolCallView>) => view("read", { path: "src/auth/session.ts" }, patch);

  it("draws the state glyph in its token at column 0 and the title at column 2", () => {
    expect(tokenOf(draw(read({ isPartial: true })).painted, "◌")).toBe("dim");
    expect(tokenOf(draw(read({ started: false })).painted, "◌")).toBe("dim");
    expect(tokenOf(draw(read(done("x"))).painted, "✓")).toBe("success");
    expect(tokenOf(draw(read(done("boom", { isError: true }))).painted, "✗")).toBe("error");
    expect(
      tokenOf(draw(read(done("Operation aborted", { isError: true, aborted: true }))).painted, "⊘"),
    ).toBe("muted");
  });

  it("shows only the verb while the key argument streams, then the full title", () => {
    expect(draw(view("read", {}, { argsComplete: false, isPartial: true })).lines).toEqual([" ◌ read"]);
    expect(draw(read({ isPartial: true })).lines).toEqual([" ◌ read src/auth/session.ts"]);
  });

  it("adds the recorded duration to a finished row from five seconds on, never to a running one", () => {
    expect(draw(read(done("x", { durationMs: 4999 }))).lines[0]).toBe(" ✓ read src/auth/session.ts");
    expect(draw(read(done("x", { durationMs: 12_400 }))).lines[0]).toBe(" ✓ read src/auth/session.ts · 12s");
    expect(draw(read({ isPartial: true, durationMs: 12_400 })).lines[0]).toBe(" ◌ read src/auth/session.ts");
  });

  it("marks a stopped call with a muted state word and its duration", () => {
    const stopped = draw(
      read(done("Operation aborted", { isError: true, aborted: true, durationMs: 72_000 })),
    );

    expect(stopped.lines).toEqual([" ⊘ read src/auth/session.ts · stopped · 1m 12s"]);
    expect(tokenOf(stopped.painted, "stopped")).toBe("muted");
  });

  it("puts a short failure reason on the title in the error colour", () => {
    const failed = draw(read(done("Path is a directory", { isError: true })));

    expect(failed.lines).toEqual([" ✗ read src/auth/session.ts · Path is a directory"]);
    expect(tokenOf(failed.painted, "Path is a directory")).toBe("error");
  });

  it("keeps every line within the width at any width", () => {
    const inputs = [
      read(done(enoent, { isError: true, durationMs: 9000 })),
      view(
        "bash",
        { command: "npm test -- --run" },
        done(`${numbered(9)}\n\nCommand exited with code 1`, { isError: true }),
      ),
      view("edit", { path: "src/stats.py" }, done("ok", {}, { diff: "-1 a\n+1 b" })),
      view("mcp__notes__search", { query: "auth" }, done(numbered(9), { label: "notes/search" })),
    ];

    [1, 2, 3, 5, 8, 12, 40, 80].forEach((columns) => {
      inputs.forEach((input) => {
        draw(input, columns).lines.forEach((line) => {
          expect(plainTheme.width(line)).toBeLessThanOrEqual(Math.max(columns, 1));
        });
      });
    });
  });
});

describe("S2 read", () => {
  const read = (args: unknown, patch: Partial<ToolCallView> = {}) => view("read", args, patch);

  it("titles a read with its accent path and muted range, and counts the lines without a hint", () => {
    const drawn = draw(read({ path: "/repo/src/auth/session.ts", offset: 5, limit: 10 }, done(numbered(10))));

    expect(drawn.lines).toEqual([" ✓ read src/auth/session.ts:5-14", "   ↳ 10 lines"]);
    expect(tokenOf(drawn.painted, "src/auth/session.ts")).toBe("accent");
    expect(tokenOf(drawn.painted, ":5-14")).toBe("muted");
    expect(tokenOf(drawn.painted, "↳")).toBe("dim");
    expect(tokenOf(drawn.painted, "10")).toBe("text");
    expect(tokenOf(drawn.painted, " lines")).toBe("muted");
    expect(drawn.bolded).toContain("read");
  });

  it("names an image and an empty file", () => {
    const image = read({ path: "a.png" }, { result: { text: "", images: 1 } });

    expect(draw(image).lines).toEqual([" ✓ read a.png", "   ↳ Image"]);
    expect(draw(read({ path: "a.txt" }, done(""))).lines).toEqual([" ✓ read a.txt", "   ↳ 0 lines"]);
  });

  it("names a missing file on the title, and gives the long error its own wrapped line when the title has no room", () => {
    expect(draw(read({ path: "src/auth/sesion.ts" }, done(enoent, { isError: true }))).lines).toEqual([
      " ✗ read src/auth/sesion.ts · file not found",
    ]);
    expect(draw(read({ path: "src/auth/sesion.ts" }, done(enoent, { isError: true })), 24).lines).toEqual([
      " ✗ read ...uth/sesion.ts",
      "   ↳ ENOENT: no such",
      "     file or directory,",
      "     ... (1 more line)",
    ]);
  });

  it("cuts the path at the start on a narrow terminal so the file name stays", () => {
    const drawn = draw(
      read({ path: "src/auth/middleware/session.ts", offset: 5, limit: 10 }, done(numbered(10))),
      40,
    );

    expect(drawn.lines).toEqual([" ✓ read ...th/middleware/session.ts:5-14", "   ↳ 10 lines"]);
  });

  it("asks for pi's body under the count when expanded, and writes the range pi's way", () => {
    expect(draw(read({ path: "a.ts" }, done("x", { expanded: true }))).piBody).toBe(true);
    expect(draw(read({ path: "a.ts", offset: 7 })).lines[0]).toBe(" ✓ read a.ts:7");
    expect(draw(read({ path: "a.ts", limit: 3 })).lines[0]).toBe(" ✓ read a.ts:1-3");
  });
});

describe("S3 edit", () => {
  const edit = (diff: string, patch: Partial<ToolCallView> = {}, columns = 80) =>
    draw(view("edit", { path: "src/stats.py" }, done("ok", patch, { diff })), columns);

  it("uses pi's verb and counts the changed lines with a dim hint", () => {
    const drawn = edit("-1 old\n+1 new");

    expect(drawn.lines).toEqual([
      " ✓ edit src/stats.py",
      "   ↳ Added 1 line, removed 1 line (ctrl+o to expand)",
    ]);
    expect(tokenOf(drawn.painted, "(ctrl+o to expand)")).toBe("dim");
    expect(edit("+1 a\n+2 b").lines[1]).toBe("   ↳ Added 2 lines (ctrl+o to expand)");
    expect(edit("-1 a\n-2 b").lines[1]).toBe("   ↳ Removed 2 lines (ctrl+o to expand)");
  });

  it("drops the hint before the summary on a narrow terminal", () => {
    expect(edit("-1 old\n+1 new", {}, 40).lines).toEqual([
      " ✓ edit src/stats.py",
      "   ↳ Added 1 line, removed 1 line",
    ]);
  });

  it("draws the expanded diff itself, and falls back to pi's body when the diff does not parse", () => {
    const expanded = edit("-1 old\n+1 new", { expanded: true });

    expect(expanded.lines.map((line) => line.trimEnd())).toEqual([
      " ✓ edit src/stats.py",
      "   ↳ Added 1 line, removed 1 line",
      "     -1 old",
      "     +1 new",
    ]);
    expect(expanded.piBody).toBe(false);
    expect(edit("@@ -1 +1 @@\n-old\n+new", { expanded: true })).toMatchObject({
      lines: [" ✓ edit src/stats.py"],
      piBody: true,
    });
  });

  it("wraps a long error at column 4", () => {
    const error =
      "Could not find the exact text in src/stats.py. The old text must match exactly including all whitespace and newlines.";
    const drawn = draw(view("edit", { path: "src/stats.py" }, done(error, { isError: true })));

    expect(drawn.lines).toEqual([
      " ✗ edit src/stats.py",
      "   ↳ Could not find the exact text in src/stats.py. The old text must match",
      "     exactly including all whitespace and newlines.",
    ]);
    expect(drawn.piBody).toBe(false);
  });
});

describe("S5 write", () => {
  it("counts the written lines with a hint, and names an empty file without one", () => {
    expect(
      draw(view("write", { path: "/home/me/notes.md", content: numbered(12) }, done("ok"))).lines,
    ).toEqual([" ✓ write ~/notes.md", "   ↳ 12 lines (ctrl+o to expand)"]);
    expect(draw(view("write", { path: "/home/me/empty.txt", content: "" }, done("ok"))).lines).toEqual([
      " ✓ write ~/empty.txt",
      "   ↳ Empty file",
    ]);
  });

  it("shows every line as added when expanded, without carriage returns", () => {
    const drawn = draw(
      view("write", { path: "a.txt", content: "one\r\ntwo" }, done("ok", { expanded: true })),
    );

    expect(drawn.lines.map((line) => line.trimEnd())).toEqual([
      " ✓ write a.txt",
      "   ↳ 2 lines",
      "     +1 one",
      "     +2 two",
    ]);
  });
});

describe("S6 bash and powershell", () => {
  const bash = (command: string, patch: Partial<ToolCallView>, columns = 80) =>
    draw(view("bash", { command }, patch), columns);

  it("shows a running command without output or duration", () => {
    expect(bash("npm test -- --run", { isPartial: true, durationMs: 12_000 }).lines).toEqual([
      " ◌ bash npm test -- --run",
    ]);
  });

  it("keeps the tail of running output under a keyed count line", () => {
    expect(bash("npm test -- --run", done(numbered(40), { isPartial: true })).lines).toEqual([
      " ◌ bash npm test -- --run",
      "   ↳ ... (37 earlier lines, ctrl+o to expand)",
      "     out 38",
      "     out 39",
      "     out 40",
    ]);
  });

  it("keeps the tail on success too, with the duration", () => {
    const drawn = bash("npm test -- --run", done(numbered(43), { durationMs: 14_000 }));

    expect(drawn.lines).toEqual([
      " ✓ bash npm test -- --run · 14s",
      "   ↳ ... (40 earlier lines, ctrl+o to expand)",
      "     out 41",
      "     out 42",
      "     out 43",
    ]);
    expect(drawn.bolded).toContain("bash");
    expect(tokenOf(drawn.painted, "npm test -- --run")).toBe("accent");
    expect(tokenOf(drawn.painted, "out 43")).toBe("muted");
    expect(tokenOf(drawn.painted, "... (40 earlier lines, ")).toBe("muted");
    expect(tokenOf(drawn.painted, "ctrl+o")).toBe("dim");
    expect(drawn.bolded).not.toContain("npm test -- --run");
  });

  it("says when there is no output", () => {
    expect(bash("git add -A", done("")).lines).toEqual([" ✓ bash git add -A", "   ↳ No output"]);
  });

  it("puts the exit code on the title and keeps the output muted without pi's status line", () => {
    const drawn = bash(
      "npm test -- --run",
      done(`${numbered(55)}\n\nCommand exited with code 1`, { isError: true, durationMs: 9000 }),
    );

    expect(drawn.lines).toEqual([
      " ✗ bash npm test -- --run · exit 1 · 9s",
      "   ↳ ... (52 earlier lines, ctrl+o to expand)",
      "     out 53",
      "     out 54",
      "     out 55",
    ]);
    expect(tokenOf(drawn.painted, "exit 1")).toBe("error");
    expect(tokenOf(drawn.painted, "out 55")).toBe("muted");
  });

  it("drops the hint, then the duration, and keeps the reason at 40 columns", () => {
    const drawn = bash(
      "npm test -- --run src/stats.test.ts",
      done(
        `${numbered(52)}\nFAIL src/stats.test.ts > mean > counts the first value\nAssertionError: expected 2 to be 3\n\nCommand exited with code 1`,
        {
          isError: true,
          durationMs: 9000,
        },
      ),
      40,
    );

    expect(drawn.lines).toEqual([
      " ✗ bash npm test -- --run sr... · exit 1",
      "   ↳ ... (51 earlier lines)",
      "     out 52",
      "     FAIL src/stats.test.ts > mean > ...",
      "     AssertionError: expected 2 to be 3",
    ]);
  });

  it("marks a stopped command and a timeout, without pi's status lines", () => {
    expect(
      bash(
        "npm run dev",
        done(`${numbered(11)}\n\nCommand aborted`, { isError: true, aborted: true, durationMs: 72_000 }),
      ).lines,
    ).toEqual([
      " ⊘ bash npm run dev · stopped · 1m 12s",
      "   ↳ ... (8 earlier lines, ctrl+o to expand)",
      "     out 9",
      "     out 10",
      "     out 11",
    ]);
    expect(
      bash("sleep 100", done("Command timed out after 30 seconds", { isError: true, durationMs: 30_000 }))
        .lines,
    ).toEqual([" ✗ bash sleep 100 · timed out after 30s"]);
  });

  it("shows a multi-line command as its first line and a muted marker", () => {
    const drawn = bash("cd app\nnpm test", { isPartial: true });

    expect(drawn.lines).toEqual([" ◌ bash cd app ..."]);
    expect(tokenOf(drawn.painted, "cd app")).toBe("accent");
    expect(tokenOf(drawn.painted, " ...")).toBe("muted");
    expect(draw(view("powershell", { command: "Get-Item ." }, { isPartial: true })).lines).toEqual([
      " ◌ powershell Get-Item .",
    ]);
  });

  it("hands the expanded output to pi's body without its timing line", () => {
    const drawn = bash("ls", done(numbered(5), { expanded: true }));

    expect(drawn.lines).toEqual([" ✓ bash ls"]);
    expect(drawn).toMatchObject({ piBody: true, dropTiming: true });
    expect(bash("ls", done("", { expanded: true }))).toMatchObject({
      lines: [" ✓ bash ls", "   ↳ No output"],
    });
  });

  it("shows a shell error with no status line as an error", () => {
    expect(bash("ls", done("spawn /bin/sh ENOENT", { isError: true })).lines).toEqual([
      " ✗ bash ls · spawn /bin/sh ENOENT",
    ]);
  });
});

describe("S7 grep, find and ls", () => {
  it("counts the results without repeating the verb, with a muted separator and no hint", () => {
    const grep = draw(view("grep", { pattern: "TODO", path: "/repo/src" }, done(numbered(12))));

    expect(grep.lines).toEqual([" ✓ grep TODO in src", "   ↳ 12 matching lines"]);
    expect(tokenOf(grep.painted, "TODO")).toBe("accent");
    expect(tokenOf(grep.painted, "src")).toBe("accent");
    expect(grep.painted.find((entry) => entry.text.startsWith(" in "))?.token).toBe("muted");
    expect(draw(view("grep", { pattern: "FIXME" }, done("No matches found"))).lines).toEqual([
      " ✓ grep FIXME",
      "   ↳ No matches",
    ]);
    expect(draw(view("find", { pattern: "**/*.test.ts" }, done(numbered(3)))).lines).toEqual([
      " ✓ find **/*.test.ts",
      "   ↳ 3 files",
    ]);
    expect(draw(view("find", { pattern: "*.md" }, done("No files found matching pattern"))).lines[1]).toBe(
      "   ↳ No files",
    );
    expect(draw(view("ls", { path: "src" }, done(numbered(8)))).lines).toEqual([
      " ✓ ls src",
      "   ↳ 8 entries",
    ]);
    expect(draw(view("ls", {}, done("(empty directory)"))).lines).toEqual([
      " ✓ ls .",
      "   ↳ Empty directory",
    ]);
    expect(draw(view("ls", {}, done("a", { expanded: true }))).piBody).toBe(true);
  });
});

describe("S8 codemode", () => {
  const code =
    'const hits = await tools.grep({ pattern: "login" });\nconst file = await tools.read({ path: hits[0].path });\nreturn file.slice(0, 200);';
  const calls = [
    { name: "grep", args: '{"pattern":"login"}', status: "ok", durationMs: 12 },
    {
      name: "read",
      args: '{"path":"src/old.ts"}',
      status: "error",
      durationMs: 3,
      error: "ENOENT: no such file or directory, open 'src/old.ts'",
    },
    { name: "jira/search_issues", args: '{"query":"auth"}', status: "cancelled", cost: 0.0012 },
    { name: "models.classify", args: '{"text":"..."}', status: "running" },
  ];
  const header = "Script completed\nWall time 1.2 seconds\nOutput:\n";
  const title = ' codemode const hits = await tools.grep({ pattern: "login" }); ...';
  const codemode = (patch: Partial<ToolCallView>) => draw(view("codemode", { code }, patch));

  it("counts the calls while it runs", () => {
    expect(codemode(done("", { isPartial: true }, { calls: calls.slice(0, 2) })).lines).toEqual([
      ` ◌${title}`,
      "   ↳ 2 calls",
    ]);
  });

  it("summarises the calls, the failed ones and the output lines with a hint", () => {
    const drawn = codemode(done(`${header}${numbered(1611)}`, {}, { calls: calls.slice(0, 3) }));

    expect(drawn.lines).toEqual([
      ` ✓${title}`,
      "   ↳ 3 calls, 1 failed · 1611 lines of output (ctrl+o to expand)",
    ]);
    expect(tokenOf(drawn.painted, "1 failed")).toBe("error");
    expect(tokenOf(drawn.painted, "1611")).toBe("text");
    expect(drawn.bolded).toContain("codemode");
  });

  it("shows the head of a failed script's error and counts the rest", () => {
    const error =
      "TypeError: Cannot read properties of undefined (reading 'path')\n    at script:3:27\na\nb\nc\nd";

    expect(codemode(done(error, { isError: true })).lines).toEqual([
      ` ✗${title}`,
      "   ↳ TypeError: Cannot read properties of undefined (reading 'path')",
      "         at script:3:27",
      "     ... (4 more lines, ctrl+o to expand)",
    ]);
  });

  it("draws its own call list when expanded: script, calls with nested marks, output", () => {
    const drawn = codemode(
      done(`${header}export function login(user: User) {\n...`, { expanded: true }, { calls }),
    );

    expect(drawn.lines).toEqual([
      ` ✓${title}`,
      "   ↳ 4 calls, 1 failed · 2 lines of output",
      '     const hits = await tools.grep({ pattern: "login" });',
      "     const file = await tools.read({ path: hits[0].path });",
      "     return file.slice(0, 200);",
      "",
      '     ✓ grep {"pattern":"login"} 12ms',
      '     ✗ read {"path":"src/old.ts"} 3ms',
      "       ENOENT: no such file or directory, open 'src/old.ts'",
      '     ⊘ jira/search_issues {"query":"auth"} $0.0012',
      '     ◌ models.classify {"text":"..."}',
      "",
      "     export function login(user: User) {",
      "     ...",
    ]);
    expect(drawn.piBody).toBe(false);
    expect(tokenOf(drawn.painted, "12ms")).toBe("dim");
    expect(tokenOf(drawn.painted, '{"pattern":"login"}')).toBe("muted");
  });

  it("names the call by the line after pi's options line", () => {
    expect(draw(view("codemode", { code: "// @options: {}\nreturn 1;" }, { isPartial: true })).lines).toEqual(
      [" ◌ codemode return 1;"],
    );
  });
});

describe("S9 MCP tools", () => {
  const output = [
    '{"results":[{"id":"n-12","title":"Auth flow notes","score":0.92},{"id":"n-13","title":"Login"},',
    '{"id":"n-14","title":"Session tokens","score":0.71},',
    '{"id":"n-15","title":"Refresh flow","score":0.66}]}',
    ...Array.from({ length: 14 }, (_value, index) => `line ${index}`),
  ].join("\n");
  const mcp = (patch: Partial<ToolCallView>, columns = 80) =>
    draw(
      view(
        "mcp__notes__search",
        { query: "auth flow", limit: 2, deep: true },
        { label: "notes/search", ...patch },
      ),
      columns,
    );

  it("titles the call server/tool with pi's key=value args and keeps the head of the output", () => {
    const drawn = mcp(done(output, { label: "notes/search" }));

    expect(drawn.lines).toEqual([
      ' ✓ notes/search query="auth flow" limit=2 deep=true',
      '   ↳ {"results":[{"id":"n-12","title":"Auth flow notes","score":0.92},{"id":"...',
      '     {"id":"n-14","title":"Session tokens","score":0.71},',
      '     {"id":"n-15","title":"Refresh flow","score":0.66}]}',
      "     ... (14 more lines, ctrl+o to expand)",
    ]);
    expect(tokenOf(drawn.painted, "notes/search")).toBe("accent");
    expect(drawn.bolded).toContain("notes/search");
    expect(tokenOf(drawn.painted, 'query="auth flow" limit=2 deep=true')).toBe("muted");
  });

  it("cuts the title and every preview line at 40 columns and drops the key from the count", () => {
    expect(mcp(done(output, { label: "notes/search" }), 40).lines).toEqual([
      ' ✓ notes/search query="auth flow" lim...',
      '   ↳ {"results":[{"id":"n-12","title"...',
      '     {"id":"n-14","title":"Session to...',
      '     {"id":"n-15","title":"Refresh fl...',
      "     ... (14 more lines)",
    ]);
  });

  it("wraps every line at column 4 when expanded", () => {
    const drawn = mcp(done('{"a":"aaaaaaaaaa bbbbbbbbbb cccccccccc"}\nend', { expanded: true }), 30);

    expect(drawn.lines.slice(1)).toEqual([
      '   ↳ {"a":"aaaaaaaaaa',
      '     bbbbbbbbbb cccccccccc"}',
      "     end",
    ]);
  });

  it("cuts each argument at 40 columns and shows at most three", () => {
    const args = { a: "x".repeat(60), b: 1, c: true, d: "hidden" };
    const title = draw(view("lint_fix", args, { isPartial: true }), 200).lines[0];

    expect(title).toBe(` ◌ lint_fix a="${"x".repeat(36)}... b=1 c=true`);
  });
});

describe("S10 unknown tools", () => {
  it("titles the call with the bold raw name", () => {
    const drawn = draw(view("lint_fix", { paths: ["src"], fix: true }, done("Fixed 3 files")));

    expect(drawn.lines).toEqual([' ✓ lint_fix paths=["src"] fix=true', "   ↳ Fixed 3 files"]);
    expect(drawn.bolded).toContain("lint_fix");
  });

  it("gives a cut single line the hint, and an error the error colour", () => {
    expect(draw(view("lint_fix", {}, done("x".repeat(100)))).lines[1]).toBe(
      `   ↳ ${"x".repeat(53)}... (ctrl+o to expand)`,
    );
    expect(draw(view("lint_fix", {}, done("x".repeat(100))), 40).lines[1]).toBe(`   ↳ ${"x".repeat(32)}...`);

    const failed = draw(view("lint_fix", {}, done("first\nsecond", { isError: true })));

    expect(failed.lines).toEqual([" ✗ lint_fix", "   ↳ first", "     second"]);
    expect(tokenOf(failed.painted, "second")).toBe("error");
  });
});

describe("diffCounts", () => {
  it("counts numbered added and removed lines only", () => {
    expect(diffCounts(parseDiff("-1 a\n+1 b\n+2 c\n 3 d\n   ...") ?? [])).toEqual({ added: 2, removed: 1 });
  });
});

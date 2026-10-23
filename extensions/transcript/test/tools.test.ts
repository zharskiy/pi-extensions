import { describe, expect, it } from "vitest";
import type { ThemeLike, ThemeToken, ToolCallView } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { diffCounts, parseDiff } from "../src/diff.ts";
import { transcriptRows } from "../src/tools.ts";

const recording = () => {
  const painted: { token: ThemeToken; text: string }[] = [];
  const bolded: string[] = [];
  const theme: ThemeLike = {
    ...plainTheme,
    fg: (token, text) => {
      painted.push({ token, text });
      return text;
    },
    bold: (text) => {
      bolded.push(text);
      return text;
    },
  };

  return { theme, painted, bolded };
};

const rows = transcriptRows(() => "ctrl+o", "/home/me");

const view = (name: string, args: unknown, patch: Partial<ToolCallView> = {}): ToolCallView => ({
  name,
  args,
  argsComplete: true,
  started: true,
  isPartial: false,
  isError: false,
  expanded: false,
  cwd: "/repo",
  ...patch,
});

const done = (text: string, patch: Partial<ToolCallView> = {}, details?: unknown): Partial<ToolCallView> => ({
  result: { text, details, isError: patch.isError, images: 0 },
  ...patch,
});

const draw = (input: ToolCallView, width = 80) => {
  const { theme, painted, bolded } = recording();
  const row = rows(input);
  const call = row?.call(width, theme) ?? [];
  const result = row?.result?.(width, theme) ?? [];

  return { call, result, painted, bolded, piBody: row?.piBody };
};

const tokenOf = (painted: { token: ThemeToken; text: string }[], text: string) =>
  painted.find((entry) => entry.text === text)?.token;

const numbered = (count: number) =>
  Array.from({ length: count }, (_value, index) => `out ${index + 1}`).join("\n");

describe("call titles", () => {
  it("paints the bullet by state: dim until the result, accent on success, error on failure", () => {
    expect(tokenOf(draw(view("read", { path: "a.ts" }, { isPartial: true })).painted, "●")).toBe("dim");
    expect(tokenOf(draw(view("read", { path: "a.ts" }, { started: false })).painted, "●")).toBe("dim");
    expect(tokenOf(draw(view("read", { path: "a.ts" }, done("x"))).painted, "●")).toBe("success");
    expect(tokenOf(draw(view("read", { path: "a.ts" }, done("x", { isError: true }))).painted, "●")).toBe(
      "error",
    );
  });

  it("names a read with its bold path and the dim line range", () => {
    const plain = draw(view("read", { path: "/repo/src/a.ts" }));
    const ranged = draw(view("read", { path: "src/a.ts", offset: 5, limit: 10 }));

    expect(plain.call).toEqual(["● Read src/a.ts"]);
    expect(plain.bolded).toContain("src/a.ts");
    expect(ranged.call).toEqual(["● Read src/a.ts (lines 5–14)"]);
    expect(tokenOf(ranged.painted, " (lines 5–14)")).toBe("dim");
  });

  it("shortens paths under the working directory and the home directory", () => {
    expect(draw(view("write", { path: "/home/me/notes.md", content: "" })).call).toEqual([
      "● Write ~/notes.md",
    ]);
    expect(draw(view("edit", { path: "/etc/hosts" })).call).toEqual(["● Update /etc/hosts"]);
    expect(draw(view("edit", { file_path: "/repo/b.ts" })).call).toEqual(["● Update b.ts"]);
  });

  it("shows the first line of a shell command after a dim prompt", () => {
    const bash = draw(view("bash", { command: "npm test\nnpm run lint" }));

    expect(bash.call).toEqual(["● $ npm test …"]);
    expect(tokenOf(bash.painted, "$")).toBe("dim");
    expect(tokenOf(bash.painted, " …")).toBe("dim");
    expect(draw(view("powershell", { command: "Get-ChildItem" })).call).toEqual(["● PS> Get-ChildItem"]);
  });

  it("names searches and listings", () => {
    expect(draw(view("grep", { pattern: "TODO", path: "/repo/src" })).call).toEqual(["● Grep TODO in src"]);
    expect(draw(view("grep", { pattern: "TODO" })).call).toEqual(["● Grep TODO"]);
    expect(draw(view("find", { pattern: "*.ts" })).call).toEqual(["● Find *.ts"]);
    expect(draw(view("ls", {})).call).toEqual(["● List ."]);
    expect(draw(view("ls", { path: "/repo/src" })).call).toEqual(["● List src"]);
  });

  it("shows only the bold tool name while the key argument is still streaming", () => {
    const streaming = { argsComplete: false, started: false, isPartial: true };

    expect(draw(view("read", {}, streaming)).call).toEqual(["● Read"]);
    expect(draw(view("edit", {}, streaming)).call).toEqual(["● Update"]);
    expect(draw(view("bash", {}, streaming)).call).toEqual(["● Bash"]);
    expect(draw(view("ls", {}, streaming)).call).toEqual(["● List"]);
    expect(draw(view("read", { path: "a.ts" }, streaming)).call).toEqual(["● Read a.ts"]);
    expect(draw(view("read", {}, streaming)).bolded).toContain("Read");
    expect(draw(view("read", {}, streaming)).result).toEqual([]);
  });

  it("summarises an unknown tool by its bold name and up to three arguments", () => {
    const mcp = draw(view("notes_search", { query: "a\nb", limit: 2, deep: true, extra: "x" }));

    expect(mcp.call).toEqual(["● notes_search query: a…, limit: 2, deep: true"]);
    expect(mcp.bolded).toContain("notes_search");
  });

  it("cuts a long title to one line", () => {
    const [line, ...rest] = draw(view("bash", { command: "x".repeat(100) }), 30).call;

    expect(rest).toEqual([]);
    expect(line?.endsWith("…")).toBe(true);
  });
});

describe("results", () => {
  it("counts the lines a read returned without an expand hint", () => {
    const read = draw(view("read", { path: "a.ts" }, done("one\ntwo\nthree\n")));

    expect(read.result).toEqual(["  ⎿  Read 3 lines"]);
    expect(read.bolded).toContain("3");
    expect(read.piBody).toBe(true);
    expect(draw(view("read", { path: "a.ts" }, { ...done("one"), expanded: true })).result).toEqual([
      "  ⎿  Read 1 line",
    ]);
  });

  it("names an image read", () => {
    const image = draw(view("read", { path: "a.png" }, { result: { text: "", images: 1 } }));

    expect(image.result).toEqual(["  ⎿  Read image"]);
  });

  it("counts an edit's added and removed lines", () => {
    const edit = (diff: string, patch: Partial<ToolCallView> = {}) =>
      draw(view("edit", { path: "a.ts" }, done("ok", patch, { diff }))).result;

    expect(edit("-1 old\n+1 new")).toEqual(["  ⎿  Added 1 line, removed 1 line (ctrl+o expand)"]);
    expect(edit("+1 a\n+2 b")).toEqual(["  ⎿  Added 2 lines (ctrl+o expand)"]);
    expect(edit("-1 a\n-2 b")).toEqual(["  ⎿  Removed 2 lines (ctrl+o expand)"]);
    expect(edit("-1 old\n+1 new", { expanded: true })).toEqual([
      "  ⎿  Added 1 line, removed 1 line",
      `     1 - old${" ".repeat(68)}`,
      `     1 + new${" ".repeat(68)}`,
    ]);
  });

  it("draws an expanded edit's diff itself and falls back to pi's body when the diff does not parse", () => {
    const edit = (diff: string) =>
      draw(view("edit", { path: "a.ts" }, done("ok", { expanded: true }, { diff })));

    expect(edit("-1 old\n+1 new").piBody).toBe(false);
    expect(edit("@@ -1 +1 @@\n-old\n+new")).toMatchObject({ result: [], piBody: true });
  });

  it("counts the lines a write wrote", () => {
    expect(draw(view("write", { path: "a.ts", content: "a\nb\n" }, done("ok"))).result).toEqual([
      "  ⎿  Wrote 2 lines (ctrl+o expand)",
    ]);
    expect(draw(view("write", { path: "a.ts", content: "" }, done("ok"))).result).toEqual([
      "  ⎿  Wrote 0 lines",
    ]);
  });

  it("shows every line of an expanded write as added lines, without carriage returns", () => {
    const content = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\r\n");
    const write = draw(view("write", { path: "a.ts", content }, done("ok", { expanded: true })), 20);

    expect(write.result).toEqual([
      "  ⎿  Wrote 12 lines",
      ...Array.from({ length: 12 }, (_value, index) =>
        `${String(index + 1).padStart(2)} + line ${index + 1}`.padEnd(15).padStart(20),
      ),
    ]);
    expect(write.result.join("")).not.toContain("\r");
  });

  it("shows only the count of an expanded empty write", () => {
    expect(draw(view("write", { path: "a.ts", content: "" }, done("ok", { expanded: true }))).result).toEqual(
      ["  ⎿  Wrote 0 lines"],
    );
  });

  it("shows an expanded edit's error lines without a body", () => {
    const failed = draw(
      view("edit", { path: "a.ts" }, done("Could not edit\nno match", { isError: true, expanded: true })),
    );

    expect(failed.result).toEqual(["  ⎿  Could not edit", "     no match"]);
    expect(failed.piBody).toBe(false);
  });

  it("shows the first three lines of shell output and how many more there are", () => {
    const bash = draw(view("bash", { command: "ls" }, done(numbered(10))));

    expect(bash.result).toEqual([
      "  ⎿  out 1",
      "     out 2",
      "     out 3",
      "     … +7 lines (ctrl+o expand)",
    ]);
    expect(tokenOf(bash.painted, "out 1")).toBe("muted");
    expect(tokenOf(bash.painted, "… +7 lines")).toBe("dim");
    expect(tokenOf(bash.painted, "(ctrl+o expand)")).toBe("dim");
  });

  it("marks empty, running and expanded shell output", () => {
    const shell = (patch: Partial<ToolCallView>) => draw(view("bash", { command: "ls" }, patch));

    expect(shell(done("")).result).toEqual(["  ⎿  (No output)"]);
    expect(shell({ ...done(""), isPartial: true }).result).toEqual(["  ⎿  Running…"]);
    expect(shell({ ...done(numbered(5)), isPartial: true }).result).toEqual([
      "  ⎿  … +2 lines",
      "     out 3",
      "     out 4",
      "     out 5",
    ]);
    expect(shell({ ...done(numbered(10)), expanded: true })).toMatchObject({ result: [], piBody: true });
  });

  it("counts search and listing results", () => {
    expect(draw(view("grep", { pattern: "x" }, done("a.ts:1: x\nb.ts:2: x"))).result).toEqual([
      "  ⎿  Found 2 lines",
    ]);
    expect(draw(view("grep", { pattern: "x" }, done("No matches found"))).result).toEqual([
      "  ⎿  No matches",
    ]);
    expect(draw(view("find", { pattern: "*.ts" }, done("a.ts\nb.ts\nc.ts"))).result).toEqual([
      "  ⎿  Found 3 files",
    ]);
    expect(draw(view("ls", {}, done("a\nb/"))).result).toEqual(["  ⎿  Listed 2 entries"]);
    expect(draw(view("ls", {}, done("(empty directory)"))).result).toEqual(["  ⎿  Listed 0 entries"]);
  });

  it("shows an unknown tool's output like shell output", () => {
    expect(draw(view("notes_search", {}, done(numbered(4)))).result).toEqual([
      "  ⎿  out 1",
      "     out 2",
      "     out 3",
      "     … +1 line (ctrl+o expand)",
    ]);
  });

  it("shows an error in the error colour, cut to three lines until expanded, without pi's body", () => {
    const failed = (expanded: boolean) =>
      draw(view("read", { path: "a.ts" }, { ...done(numbered(5), { isError: true }), expanded }));

    expect(failed(false).result).toEqual([
      "  ⎿  out 1",
      "     out 2",
      "     out 3",
      "     … +2 lines (ctrl+o expand)",
    ]);
    expect(tokenOf(failed(false).painted, "out 1")).toBe("error");
    expect(failed(false).piBody).toBe(false);
    expect(failed(true).result).toHaveLength(5);
  });

  it("keeps the last lines of a failed shell command, where the error is", () => {
    const failed = (expanded: boolean) =>
      draw(view("bash", { command: "make" }, { ...done(numbered(5), { isError: true }), expanded }));

    expect(failed(false).result).toEqual([
      "  ⎿  … +2 lines",
      "     out 3",
      "     out 4",
      "     out 5 (ctrl+o expand)",
    ]);
    expect(tokenOf(failed(false).painted, "out 5")).toBe("error");
    expect(failed(true).result).toHaveLength(5);
  });
});

describe("codemode rows", () => {
  const code = 'const hits = await tools.grep({ pattern: "login" });\nreturn hits;';
  const header = "Script completed\nWall time 0.4 seconds\nOutput:\n\n";
  const calls = [
    { name: "grep", status: "ok" },
    { name: "read", status: "error" },
  ];
  const codemode = (text: string, patch: Partial<ToolCallView> = {}, details: unknown = { calls }) =>
    draw(view("codemode", { code }, done(text, patch, details)));

  it("names the call by the first line of its script", () => {
    expect(draw(view("codemode", { code })).call).toEqual([
      '● codemode const hits = await tools.grep({ pattern: "login" }); …',
    ]);
    expect(draw(view("codemode", {}, { argsComplete: false })).call).toEqual(["● codemode"]);
  });

  it("counts the nested calls, the failed ones and the output lines, without the script header", () => {
    expect(codemode(`${header}${numbered(1611)}`).result).toEqual([
      "  ⎿  2 tool calls, 1 failed, 1611 lines of output (ctrl+o expand)",
    ]);
    expect(codemode(`${header}`, {}, { calls: [] }).result).toEqual(["  ⎿  (No output) (ctrl+o expand)"]);
    expect(codemode(header, { isPartial: true }).result).toEqual(["  ⎿  Running… · 2 tool calls"]);
    expect(codemode(header, { isPartial: true }, { calls: [] }).result).toEqual(["  ⎿  Running…"]);
  });

  it("shows the whole script above pi's own calls and output when expanded", () => {
    const expanded = codemode(`${header}out`, { expanded: true });

    expect(expanded.result).toEqual([
      '  ⎿  const hits = await tools.grep({ pattern: "login" });',
      "     return hits;",
      "     ",
    ]);
    expect(expanded.piBody).toBe(true);
  });

  const failure =
    "Script failed\nWall time 0.1 seconds\nOutput:\n\nhalf done\nScript error:\nReferenceError: x\n\n" +
    "Tool calls made before the failure (they are not undone): grep (ok), read (error)";

  it("shows the first lines of a failed script's error without the script header", () => {
    const failed = codemode(failure, { isError: true });

    expect(failed.result).toEqual([
      "  ⎿  half done",
      "     Script error:",
      "     ReferenceError: x",
      "     … +2 lines (ctrl+o expand)",
    ]);
    expect(tokenOf(failed.painted, "ReferenceError: x")).toBe("error");
    expect(failed.piBody).toBe(false);
  });

  it("keeps the script above the whole error when a failed script is expanded", () => {
    const failed = draw(
      view("codemode", { code }, done(failure, { isError: true, expanded: true }, { calls })),
      120,
    );

    expect(failed.result).toEqual([
      '  ⎿  const hits = await tools.grep({ pattern: "login" });',
      "     return hits;",
      "     ",
      "     half done",
      "     Script error:",
      "     ReferenceError: x",
      "     ",
      "     Tool calls made before the failure (they are not undone): grep (ok), read (error)",
    ]);
  });

  it("names the call by the line after pi's options line", () => {
    const options = draw(view("codemode", { code: '// @options: {"timeout_ms": 1000}\nreturn 1;' }));

    expect(options.call).toEqual(["● codemode return 1;"]);
  });
});

describe("diffCounts", () => {
  it("counts numbered added and removed lines only", () => {
    expect(diffCounts(parseDiff("  1 same\n- 2 old\n+ 2 new\n+ 3 more\n    ..."))).toEqual({
      added: 2,
      removed: 1,
    });
    expect(diffCounts(parseDiff(""))).toEqual({ added: 0, removed: 0 });
  });
});

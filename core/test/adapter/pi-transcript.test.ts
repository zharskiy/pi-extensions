import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AnyToolSpec, TranscriptItem } from "../../adapter/contract.ts";
import { installMessageRows, uninstallMessageRows } from "../../adapter/pi-message-rows.ts";
import { toolRowsHost } from "../../adapter/pi-tool-rows.ts";
import { capturePiRenderers, createTranscriptPane } from "../../adapter/pi-transcript.ts";
import { initRenderTheme } from "./render-theme.ts";

initRenderTheme();

const ESC = String.fromCharCode(27);

const APC = new RegExp(
  `${String.fromCharCode(27)}_[^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`,
  "g",
);
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const visibleText = (lines: string[]) => lines.join("\n").replace(APC, "").replace(SGR, "");

const tui = { requestRender: () => {} } as never;

const assistantCall = (name: string, args: unknown, id = "call-1"): TranscriptItem => ({
  kind: "assistant",
  text: "",
  toolCalls: [{ name, args }],
  raw: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
    timestamp: 0,
  },
});

const toolResult = (name: string, text: string, details?: unknown, id = "call-1"): TranscriptItem => ({
  kind: "tool",
  toolName: name,
  toolCallId: id,
  text,
  isError: false,
  raw: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    details,
    isError: false,
  },
});

describe("transcript pane spacing", () => {
  it("puts pi's spacer between items and none before the first", () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([
      { kind: "user", text: "find the files" },
      { kind: "user", text: "and the tests" },
    ]);

    const lines = pane.render(60).map((line) => stripVTControlCharacters(line));

    expect(lines[0]?.trim()).toBe("");
    expect(lines[1]).toContain("find the files");
    expect(lines.findIndex((line) => line.includes("and the tests"))).toBeGreaterThan(3);
    expect(lines[lines.findIndex((line) => line.includes("and the tests")) - 2]).toBe("");
  });
});

describe("transcript pane routed messages", () => {
  it("renders a routed message as a plain user message, header included", () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([{ kind: "user", text: "[message from main]\nfocus on tests" }]);

    const lines = pane.render(60).map((line) => stripVTControlCharacters(line));
    const header = lines.findIndex((line) => line.includes("[message from main]"));

    expect(header).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((line) => line.includes("focus on tests"))).toBeGreaterThan(header);
    expect(lines.filter((line) => line.includes("message from main"))).toHaveLength(1);
  });
});

describe("transcript pane terminal marks", () => {
  it("drops prompt marks from pi's message lines and keeps colours", () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([
      { kind: "user", text: "find the files" },
      {
        kind: "assistant",
        text: "Three files",
        toolCalls: [],
        raw: {
          role: "assistant",
          content: [{ type: "text", text: "Three files" }],
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ]);

    const raw = pane.render(60).join("\n");

    expect(raw).not.toContain(`${ESC}]133;`);
    expect(raw).toContain("find the files");
    expect(raw).toContain("Three files");
    expect(raw).toMatch(SGR);
  });
});

describe("pi renderers in the transcript pane", () => {
  it("captures codemode and tool_search renderers from pi's factories", () => {
    const captured = capturePiRenderers({
      codemode: createCodemodeExtension,
      tool_search: createToolSearchExtension,
    });

    expect(captured.codemode?.renderCall).toBeTypeOf("function");
    expect(captured.codemode?.renderResult).toBeTypeOf("function");
    expect(captured.tool_search?.renderCall).toBeUndefined();
  });

  it("leaves out a factory that throws or registers no renderer", () => {
    const captured = capturePiRenderers({
      codemode: createCodemodeExtension,
      broken: () => {
        throw new Error("boom");
      },
      silent: () => () => {},
    });

    expect(Object.keys(captured)).toEqual(["codemode"]);
  });

  it("renders a codemode call with pi's renderer in the transcript pane", () => {
    const pane = createTranscriptPane(tui, "/repo");
    const code = 'const hits = await tools.grep({ pattern: "login" });\nreturn hits;';

    pane.sync([
      assistantCall("codemode", { code }),
      toolResult("codemode", "src/auth/login.ts", {
        calls: [{ id: "n1", name: "grep", args: "{}", status: "ok", durationMs: 12 }],
      }),
    ]);

    const text = visibleText(pane.render(80));

    expect(text).toContain("codemode");
    expect(text).toContain("tools.grep");
    expect(text).toContain("✓ grep {} 12ms");
    expect(text).toContain("src/auth/login.ts");
    expect(text).not.toContain('"code"');
  });

  it("renders custom specs passed to createTranscript with their own renderers", () => {
    const spec = {
      name: "run_agent",
      label: "Run agent",
      description: "run",
      parameters: {},
      execute: async () => ({ text: "" }),
      renderCall: () => "RUN-AGENT-ROW",
      renderResult: (result: { text: string }) => `RESULT ${result.text}`,
    } as unknown as AnyToolSpec;
    const pane = createTranscriptPane(tui, "/repo", { tools: [spec] });

    pane.sync([assistantCall("run_agent", { agents: [] }), toolResult("run_agent", "ids")]);

    const text = visibleText(pane.render(80));

    expect(text).toContain("RUN-AGENT-ROW");
    expect(text).toContain("RESULT ids");
    expect(text).not.toContain('"agents"');
  });

  it("keeps the raw fallback for unknown tools", () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([assistantCall("mystery", { q: "x" }), toolResult("mystery", "found it")]);

    const text = visibleText(pane.render(80));

    expect(text).toContain("mystery");
    expect(text).toContain('"q": "x"');
    expect(text).toContain("found it");
  });
});

describe("transcript pane pending results", () => {
  const pendingSpec = (pendingResult: (id: string, owner: string | undefined) => unknown) =>
    ({
      name: "run_agent",
      label: "Run agent",
      description: "run",
      parameters: {},
      renderShell: "row",
      execute: async () => ({ text: "" }),
      renderCall: () => "",
      renderResult: (result: { details?: { n: number } }, state: { isPartial: boolean }) =>
        `BATCH ${result.details?.n} partial ${state.isPartial}`,
      pendingResult,
    }) as unknown as AnyToolSpec;

  it("fills an executing call once with the spec's partial result until its result arrives", () => {
    const asked: [string, string | undefined][] = [];
    const pane = createTranscriptPane(tui, "/repo", {
      owner: "explorer-1",
      tools: [
        pendingSpec((id, owner) => {
          asked.push([id, owner]);
          return { text: "", details: { n: 1 } };
        }),
      ],
    });
    const call = assistantCall("run_agent", { agents: [] }, "ra1");

    pane.sync([call]);

    expect(visibleText(pane.render(80))).toContain("BATCH 1 partial true");
    expect(visibleText(pane.render(80))).toContain("BATCH 1 partial true");
    expect(asked).toEqual([["ra1", "explorer-1"]]);

    pane.sync([call, toolResult("run_agent", "done", { n: 2 }, "ra1")]);

    const text = visibleText(pane.render(80));

    expect(text).toContain("BATCH 2 partial false");
    expect(text).not.toContain("partial true");
  });

  it("leaves the call blank and asks again on the next render while the spec has nothing", () => {
    let partial: unknown;
    let asked = 0;
    const pane = createTranscriptPane(tui, "/repo", {
      tools: [
        pendingSpec(() => {
          asked += 1;
          return partial;
        }),
      ],
    });

    pane.sync([assistantCall("run_agent", { agents: [] }, "ra1")]);

    expect(visibleText(pane.render(80))).not.toContain("BATCH");

    partial = { text: "", details: { n: 3 } };

    expect(visibleText(pane.render(80))).toContain("BATCH 3 partial true");
    expect(asked).toBe(2);
  });

  it("never asks for a call whose result is already in the transcript", () => {
    let asked = 0;
    const pane = createTranscriptPane(tui, "/repo", {
      tools: [
        pendingSpec(() => {
          asked += 1;
          return { text: "", details: { n: 1 } };
        }),
      ],
    });

    pane.sync([
      assistantCall("run_agent", { agents: [] }, "ra1"),
      toolResult("run_agent", "done", { n: 2 }, "ra1"),
    ]);

    expect(visibleText(pane.render(80))).toContain("BATCH 2 partial false");
    expect(asked).toBe(0);
  });
});

const grepOutput = Array.from({ length: 40 }, (_, index) => `src/file.ts:${index}: line ${index}`).join("\n");

const grepPane = () => {
  const pane = createTranscriptPane(tui, "/repo");

  pane.sync([
    { kind: "user", text: "find the lines" },
    assistantCall("grep", { pattern: "line", path: "src" }, "g1"),
    toolResult("grep", grepOutput, {}, "g1"),
    assistantCall("grep", { pattern: "other", path: "src" }, "g2"),
  ]);

  return pane;
};

const plainLines = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));

describe("transcript pane clicks", () => {
  it("expands one tool result on a click and collapses it on a second click", () => {
    const pane = grepPane();
    const collapsed = plainLines(pane.render(80));
    const row = collapsed.findIndex((line) => line.includes("line 3"));

    expect(collapsed.join("\n")).toContain("25 more lines");
    expect(pane.click(row, 4, 80)).toBe(true);

    const expanded = plainLines(pane.render(80));

    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.join("\n")).toContain("line 39");
    expect(expanded.join("\n")).not.toContain("25 more lines");
    expect(pane.click(row, 4, 80)).toBe(true);
    expect(plainLines(pane.render(80))).toEqual(collapsed);
  });

  it("ignores clicks on a user message, on a call without a result and outside the transcript", () => {
    const pane = grepPane();
    const lines = plainLines(pane.render(80));
    const user = lines.findIndex((line) => line.includes("find the lines"));
    const pending = lines.findIndex((line) => line.includes("other"));

    expect(pane.click(user, 4, 80)).toBe(false);
    expect(pane.click(pending, 4, 80)).toBe(false);
    expect(pane.click(lines.length + 5, 4, 80)).toBe(false);
    expect(plainLines(pane.render(80))).toEqual(lines);
  });

  it("lets the global toggle reset a call opened by a click", () => {
    const pane = grepPane();
    const collapsed = plainLines(pane.render(80));

    pane.click(
      collapsed.findIndex((line) => line.includes("line 3")),
      4,
      80,
    );
    pane.setToolsExpanded(false);

    expect(plainLines(pane.render(80))).toEqual(collapsed);
  });
});

describe("transcript pane tool rows", () => {
  const readRow = () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([assistantCall("read", { path: "src/a.ts" }), toolResult("read", "one\ntwo")]);

    return visibleText(pane.render(60));
  };

  it("draws built-in tools with the registered rows, and with pi's renderers without them", () => {
    const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

    expect(readRow()).toContain("read src/a.ts");

    host.registerToolRows((view) => ({
      call: () => [`● Read ${(view.args as { path: string }).path}`],
      result: () => [`  ⎿  Read ${view.result?.text.split("\n").length} lines`],
    }));

    const rows = readRow();

    host.release();

    expect(rows).toContain(" ● Read src/a.ts\n   ⎿  Read 2 lines");
    expect(readRow()).not.toContain("● Read");
  });
});

describe("transcript pane message rows", () => {
  it("draws the agent view's user messages and built-in tools as rows once they are installed", async () => {
    const themeModule = await import(
      new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    );
    const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

    installMessageRows(() => themeModule.theme);
    host.registerToolRows(() => ({ call: () => ["● Read a.ts"], result: () => ["  ⎿  Read 2 lines"] }));

    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([
      { kind: "user", text: "find the files" },
      assistantCall("read", { path: "a.ts" }),
      toolResult("read", "one\ntwo"),
    ]);

    const text = visibleText(pane.render(60));

    host.release();
    uninstallMessageRows();

    expect(text).toContain(" ❯ find the files");
    expect(text).toContain(" ● Read a.ts\n   ⎿  Read 2 lines");
  });
});

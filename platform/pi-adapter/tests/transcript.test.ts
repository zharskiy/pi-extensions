import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { plainLines } from "../../../test/framework/index.ts";
import { initPiRenderTheme, renderPaneToolRows, visible } from "../../../test/framework/pi/index.ts";
import type { AnyToolSpec, ToolCallView, TranscriptItem } from "../index.ts";
import { entryHost } from "../tools/entry-renderers.ts";
import { toolRowsHost } from "../tools/tool-rows.ts";
import { capturePiRenderers, createTranscriptPane } from "../tools/transcript.ts";
import { releaseLabel, storeLabel } from "../ui/thinking-label.ts";

initPiRenderTheme();

const ESC = String.fromCharCode(27);

const visibleText = (lines: string[]) => visible(lines.join("\n"));

const tui = { requestRender: () => {} } as never;

const assistantCall = (name: string, args: unknown, id = "call-1"): TranscriptItem => ({
  kind: "assistant",
  raw: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
    timestamp: 0,
  },
});

const toolResult = (name: string, text: string, details?: unknown, id = "call-1"): TranscriptItem => ({
  kind: "tool",
  toolCallId: id,
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
    expect(stripVTControlCharacters(raw)).not.toBe(raw);
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

  it("draws a codemode call as a row once rows are registered", () => {
    const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

    host.registerToolRows((view) => ({
      call: () => [`✓ ${view.name}`],
      result: () => [
        `  ↳ ${(view.result?.details as { calls?: unknown[] } | undefined)?.calls?.length} tool call`,
      ],
    }));

    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([
      assistantCall("codemode", { code: "return 1" }),
      toolResult("codemode", "src/auth/login.ts", {
        calls: [{ id: "n1", name: "grep", args: "{}", status: "ok", durationMs: 12 }],
      }),
    ]);

    const text = visibleText(pane.render(80));

    host.release();

    expect(text).toContain("✓ codemode\n   ↳ 1 tool call");
    expect(text).not.toContain("✓ grep");
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
      call: () => [`✓ Read ${(view.args as { path: string }).path}`],
      result: () => [`  ↳ Read ${view.result?.text.split("\n").length} lines`],
    }));

    const rows = readRow();

    host.release();

    expect(rows).toContain(" ✓ Read src/a.ts\n   ↳ Read 2 lines");
    expect(readRow()).not.toContain("✓ Read");
  });
});

const glyph = (view: ToolCallView) => {
  if (view.started === false || view.isPartial) {
    return "◌";
  }

  if (view.aborted) {
    return "⊘";
  }

  return view.isError ? "✗" : "✓";
};

describe("transcript pane tool views", () => {
  const seen: ToolCallView[] = [];
  const rows = (view: ToolCallView) => {
    seen.push(view);

    return { call: () => [`${glyph(view)} ${view.label ?? view.name}`], result: () => [] };
  };

  it("passes the duration stored in the result to the rows", () => {
    seen.length = 0;
    renderPaneToolRows(rows, {
      name: "read",
      args: { path: "a.ts" },
      result: "one",
      durationMs: 6_000,
      width: 60,
    });

    expect(seen.filter((view) => view.result).map((view) => view.durationMs)).toContain(6_000);
  });

  it("draws the open calls of an aborted turn stopped and of a failed turn failed", () => {
    const drawn = (stopReason: "aborted" | "error") =>
      renderPaneToolRows(rows, { name: "bash", args: { command: "ls" }, stopReason, width: 60 })[0];

    expect(drawn("aborted")).toBe(" ⊘ bash");
    expect(drawn("error")).toBe(" ✗ bash");
  });

  it("draws a finished call done", () => {
    expect(
      renderPaneToolRows(rows, { name: "read", args: { path: "a.ts" }, result: "one", width: 60 })[0],
    ).toBe(" ✓ read");
  });

  it("labels MCP tools by pi's naming pattern", () => {
    expect(
      renderPaneToolRows(rows, { name: "mcp__notes__search", args: {}, result: "x", width: 60 })[0],
    ).toBe(" ✓ notes/search");
  });
});

describe("transcript pane messages", () => {
  it("draws user and assistant messages in pi's default look with the stored thinking label", () => {
    const owner = {};

    storeLabel("Thinking", owner);

    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([
      { kind: "user", text: "find the files" },
      {
        kind: "assistant",
        raw: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Looking around." },
            { type: "text", text: "Found them." },
          ],
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ]);

    const text = visibleText(pane.render(60));

    releaseLabel(owner);

    expect(text).toContain(" find the files");
    expect(text).toContain(" Thinking");
    expect(text).toContain(" Found them.");
    expect(text).not.toContain("Looking around.");
    expect(text).not.toMatch(/[❯●∴]/);
  });
});

describe("transcript pane custom messages", () => {
  const registerWith = (host: ReturnType<typeof entryHost>, customType: string, marker: string) => {
    host.registerMessageRenderer(customType, (message, _width, expanded) => [
      `${marker} ${message.text}${expanded ? " (expanded)" : ""}`,
    ]);
  };

  const noop = { registerEntryRenderer: () => {}, registerMessageRenderer: () => {} } as never;

  const custom = (customType: string, display = true): TranscriptItem => ({
    kind: "custom",
    raw: { role: "custom", customType, content: "the request", display, timestamp: 0 },
  });

  it("draws a custom message with a renderer another adapter copy registered", () => {
    const other = entryHost(noop);
    const pane = createTranscriptPane(tui, "/repo");

    registerWith(other, "pi-handoff-request", "REQUEST");
    pane.sync([custom("pi-handoff-request")]);

    expect(visibleText(pane.render(60))).toContain("REQUEST the request");

    other.release();
  });

  it("follows the pane's expanded toggle", () => {
    const other = entryHost(noop);
    const pane = createTranscriptPane(tui, "/repo");

    registerWith(other, "pi-handoff-request", "REQUEST");
    pane.sync([custom("pi-handoff-request")]);
    pane.setToolsExpanded(true);

    expect(visibleText(pane.render(60))).toContain("REQUEST the request (expanded)");

    other.release();
  });

  it("keeps drawing with the other copy's renderer when one copy shuts down", () => {
    const first = entryHost(noop);
    const second = entryHost(noop);
    const pane = createTranscriptPane(tui, "/repo");

    registerWith(first, "pi-handoff-request", "FIRST");
    registerWith(second, "pi-handoff-request", "SECOND");
    second.release();
    pane.sync([custom("pi-handoff-request")]);

    expect(visibleText(pane.render(60))).toContain("FIRST the request");

    first.release();
  });

  it("falls back to pi's component for an unknown type and draws nothing for a hidden message", () => {
    const pane = createTranscriptPane(tui, "/repo");

    pane.sync([custom("unknown-type"), custom("pi-handoff-request", false)]);

    const text = visibleText(pane.render(60));

    expect(text).toContain("[unknown-type]");
    expect(text).not.toContain("pi-handoff-request");
  });
});

import {
  createCodemodeExtension,
  createToolSearchExtension,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AnyToolSpec, TranscriptItem } from "../../adapter/contract.ts";
import {
  capturePiRenderers,
  createInputPane,
  createTranscriptPane,
  createUi,
  editorKeyPress,
  type HostState,
  notificationSequence,
} from "../../adapter/pi-ui.ts";
import { initRenderTheme } from "./render-theme.ts";

initRenderTheme();

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

const APC = new RegExp(
  `${String.fromCharCode(27)}_[^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`,
  "g",
);
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const visibleText = (lines: string[]) => lines.join("\n").replace(APC, "").replace(SGR, "");

const typeText = (pane: ReturnType<typeof createInputPane>, text: string) =>
  text.split("").map((char) => pane.feed({ name: "other", char, raw: char }));

describe("createInputPane", () => {
  it("collects typed characters as changes", () => {
    const pane = createInputPane("type");
    const outcomes = typeText(pane, "hi");

    expect(outcomes).toEqual(["changed", "changed"]);
    expect(pane.value()).toBe("hi");
    expect(visibleText(pane.render(30))).toContain("hi");
  });

  it("reports submitted on enter and cancelled on escape", () => {
    const pane = createInputPane("type");

    expect(pane.feed({ name: "enter", raw: "\r" })).toBe("submitted");
    expect(pane.feed({ name: "escape", raw: "\x1b" })).toBe("cancelled");
    expect(pane.feed({ name: "other", char: "a", raw: "a" })).toBe("changed");
  });

  it("deletes the last character on backspace", () => {
    const pane = createInputPane("type");

    typeText(pane, "abc");

    expect(pane.feed({ name: "other", raw: "\x7f" })).toBe("changed");
    expect(pane.value()).toBe("ab");
  });

  it("sets the value and renders it", () => {
    const pane = createInputPane("type");

    pane.setValue("preset");

    expect(pane.value()).toBe("preset");
    expect(visibleText(pane.render(30))).toContain("preset");
  });
});

describe("createInputPane focus", () => {
  it("draws the cursor marker only while focused", () => {
    const pane = createInputPane("type");

    pane.setValue("hi");
    pane.setFocused(false);

    expect(pane.render(30).join("")).not.toContain(CURSOR_MARKER);

    pane.setFocused(true);

    expect(pane.render(30).join("")).toContain(CURSOR_MARKER);
  });
});

describe("editorKeyPress", () => {
  it("editorKeyPress names up and down through the keybindings manager", () => {
    const ctrlP = String.fromCharCode(16);
    const ctrlN = String.fromCharCode(14);
    const ctrlO = String.fromCharCode(15);
    const map: Record<string, string> = {
      [ctrlP]: "tui.editor.cursorUp",
      [ctrlN]: "tui.editor.cursorDown",
      [ctrlO]: "app.tools.expand",
    };
    const keys = { matches: (data: string, id: string) => map[data] === id };

    const names = [ctrlP, ctrlN, ctrlO, `${ESC}[A`, `${ESC}[B`, ESC, "\r", " ", "x"].map(
      (data) => editorKeyPress(data, keys).name,
    );

    expect(names).toEqual([
      "up",
      "down",
      "toggleTools",
      "other",
      "other",
      "escape",
      "enter",
      "space",
      "other",
    ]);
    expect(editorKeyPress("x", keys).char).toBe("x");
  });

  it("editorKeyPress names left and right through the keybindings manager", () => {
    const map: Record<string, string> = {
      [`${ESC}[D`]: "tui.editor.cursorLeft",
      [`${ESC}[C`]: "tui.editor.cursorRight",
    };
    const keys = { matches: (data: string, id: string) => map[data] === id };

    expect(editorKeyPress(`${ESC}[D`, keys).name).toBe("left");
    expect(editorKeyPress(`${ESC}[C`, keys).name).toBe("right");
    expect(editorKeyPress(`${ESC}[D`, { matches: () => false }).name).toBe("other");
  });
});

const keyContext = (mode: string) => {
  const inputs: ((data: string) => unknown)[] = [];
  const removed: number[] = [];
  const state: HostState = {
    ctx: {
      mode,
      ui: {
        onTerminalInput: (handler: (data: string) => unknown) => {
          inputs.push(handler);
          return () => {
            removed.push(inputs.indexOf(handler));
          };
        },
      },
    } as unknown as ExtensionContext,
  };

  return { ui: createUi(state, { write: () => {} }, {}), inputs, removed };
};

describe("onKeyPress", () => {
  it("onKeyPress calls the listener for keys, skips SGR and X10 mouse reports and key releases, and never consumes", () => {
    const { ui, inputs, removed } = keyContext("tui");
    let presses = 0;

    const off = ui.onKeyPress(() => {
      presses += 1;
    });

    const results = ["a", `${ESC}[A`, `${ESC}[<0;10;5M`, `${ESC}[M abc`, `${ESC}[97;1:3u`, "\r"].map((data) =>
      inputs[0]?.(data),
    );

    off();

    expect(inputs).toHaveLength(1);
    expect(presses).toBe(3);
    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(removed).toEqual([0]);
  });

  it("onKeyPress is a no-op outside tui", () => {
    const silent = ["rpc", "print", "json"].map((mode) => {
      const { ui, inputs } = keyContext(mode);
      const off = ui.onKeyPress(() => {});

      off();

      return inputs.length;
    });

    expect(silent).toEqual([0, 0, 0]);
  });
});

const captured = (mode: string, env = {}) => {
  const writes: string[] = [];
  const state: HostState = { ctx: { mode } as unknown as ExtensionContext };
  const ui = createUi(state, { write: (data: string) => writes.push(data) }, env);

  return { ui, writes, state };
};

describe("terminalNotify", () => {
  it("writes one OSC 9 notification without a bell in tui mode", () => {
    const { ui, writes } = captured("tui", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" });

    ui.terminalNotify("pi is waiting for your input", "auto");

    expect(writes).toEqual([`${ESC}]9;pi is waiting for your input${BEL}`]);
  });

  it("writes OSC 777 titled pi for rxvt terminals", () => {
    const { ui, writes } = captured("tui", { TERM: "rxvt-unicode-256color" });

    ui.terminalNotify("pi is waiting for your input", "auto");

    expect(writes).toEqual([`${ESC}]777;notify;pi;pi is waiting for your input${BEL}`]);
  });

  it("writes only the bell for the bell channel", () => {
    const ghostty = captured("tui", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" });
    const rxvt = captured("tui", { TERM: "rxvt-unicode-256color" });

    ghostty.ui.terminalNotify("pi is waiting for your input", "bell");
    rxvt.ui.terminalNotify("pi is waiting for your input", "bell");

    expect(ghostty.writes).toEqual([BEL]);
    expect(rxvt.writes).toEqual([BEL]);
  });

  it("writes nothing in rpc, print or json mode, or once the session is stale", () => {
    const silent = ["rpc", "print", "json"].map((mode) => {
      const { ui, writes } = captured(mode);

      ui.terminalNotify("message", "auto");
      ui.terminalNotify("message", "bell");

      return writes.length;
    });

    const stale = captured("tui");

    stale.state.ctx = undefined;
    stale.ui.terminalNotify("message", "auto");
    stale.ui.terminalNotify("message", "bell");

    expect(silent).toEqual([0, 0, 0]);
    expect(stale.writes).toEqual([]);
  });

  it("replaces control characters in the message", () => {
    const message = `a${ESC}]0;x\nline${BEL}`;

    expect(notificationSequence(message, "auto", {})).toBe(`${ESC}]9;a ]0;x line${BEL}`);
    expect(notificationSequence(message, "auto", { TERM_PROGRAM: "urxvt" })).toBe(
      `${ESC}]777;notify;pi;a ]0;x line${BEL}`,
    );
  });
});

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

  it("falls back to the generic display when a factory throws", () => {
    const captured = capturePiRenderers({
      broken: () => {
        throw new Error("boom");
      },
      silent: () => () => {},
    });

    expect(captured).toEqual({});

    const pane = createTranscriptPane(tui, "/repo", { piRenderers: captured });

    pane.sync([assistantCall("broken", { a: 1 }), toolResult("broken", "raw output")]);

    const text = visibleText(pane.render(80));

    expect(text).toContain("broken");
    expect(text).toContain('"a": 1');
    expect(text).toContain("raw output");
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

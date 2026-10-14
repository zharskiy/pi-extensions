import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolRenderState, ToolResult, ToolSpec, ToolTone } from "../../adapter/contract.ts";
import { type PiToolRenderContext, toPiTool } from "../../adapter/pi-tools.ts";

/** pi's dark theme, whose three tool backgrounds differ (the system theme leaves them at the terminal default). */
initTheme("dark", false);

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const invalidate = () => {};

const context = (patch: Partial<PiToolRenderContext> = {}) =>
  ({
    args: {},
    toolCallId: "call-7",
    invalidate,
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: 42,
    outputPad: 1,
    ...patch,
  }) as PiToolRenderContext;

type Renderers = {
  renderShell?: "default" | "self" | "box";
  renderCall(args: unknown, theme: Theme, context: PiToolRenderContext): Component;
  renderResult(
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: PiToolRenderContext,
  ): Component;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ): Promise<unknown>;
};

const piTool = <P, D>(spec: ToolSpec<P, D>) => toPiTool(spec) as unknown as Renderers;

const baseSpec = {
  name: "probe",
  label: "Probe",
  description: "probe",
  parameters: {},
  execute: async () => ({ text: "ok" }),
};

const piResult = (text: string, extra: object = {}) => ({ content: [{ type: "text", text }], ...extra });

const options = { expanded: false, isPartial: false };

describe("toPiTool render state", () => {
  it("passes the render state to renderCall and renderResult", () => {
    const states: ToolRenderState[] = [];
    const tool = piTool({
      ...baseSpec,
      renderCall: (_params, _theme, state) => {
        states.push(state);
        return "call";
      },
      renderResult: (_result, state) => {
        states.push(state);
        return "result";
      },
    });

    tool.renderCall({}, theme, context({ isError: true }));
    tool.renderResult(piResult("x"), options, theme, context({ isError: true }));

    expect(states).toHaveLength(2);
    expect(states.map((state) => [state.toolCallId, state.durationMs, state.isError])).toEqual([
      ["call-7", 42, true],
      ["call-7", 42, true],
    ]);
    expect(states.every((state) => state.invalidate === invalidate)).toBe(true);
  });

  it("passes the call arguments as state.args to renderCall and renderResult", () => {
    const seen: unknown[] = [];
    const tool = piTool({
      ...baseSpec,
      renderCall: (_params, _theme, state) => {
        seen.push(state.args);
        return "";
      },
      renderResult: (_result, state) => {
        seen.push(state.args);
        return "";
      },
    });

    tool.renderCall({ wait: true }, theme, context({ args: { wait: true } }));
    tool.renderResult(piResult("x"), options, theme, context({ args: { wait: true } }));

    expect(seen).toEqual([{ wait: true }, { wait: true }]);
  });

  it("copies isError into the result renderResult receives", () => {
    const seen: [ToolResult<unknown>, boolean][] = [];
    const tool = piTool({
      ...baseSpec,
      renderResult: (result, state) => {
        seen.push([result, state.isError]);
        return "";
      },
    });

    tool.renderResult(piResult("bad", { isError: true }), options, theme, context({ isError: true }));
    tool.renderResult(piResult("bad"), options, theme, context({ isError: true }));
    tool.renderResult(piResult("fine"), options, theme, context());

    expect(seen.map(([result, isError]) => [result.isError ?? false, isError])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    expect(seen[0]?.[0].text).toBe("bad");
  });

  it("forwards update details", async () => {
    const updates: unknown[] = [];
    const tool = piTool<Record<string, never>, { step: number }>({
      ...baseSpec,
      execute: async (_params, ctx) => {
        ctx.update("half", { step: 1 });
        ctx.update("plain");
        return { text: "done" };
      },
    });

    await tool.execute("id", {}, undefined, (update) => updates.push(update), {});

    expect(updates).toEqual([
      { content: [{ type: "text", text: "half" }], details: { step: 1 } },
      { content: [{ type: "text", text: "plain" }], details: undefined },
    ]);
  });

  it("keeps string-only renderers working", () => {
    const tool = piTool<{ name?: string }, unknown>({
      ...baseSpec,
      renderCall: (params, style) => style.bold(`call ${params.name}`),
      renderResult: (result, state: { expanded: boolean; invalidate(): void }) =>
        `${result.text} ${state.expanded ? "open" : "closed"}`,
    });

    const call = tool.renderCall({ name: "x" }, theme, context());
    const result = tool.renderResult(piResult("out"), options, theme, context());

    expect(call).toBeInstanceOf(Text);
    expect(call.render(40)[0]?.trimEnd()).toBe("call x");
    expect(result.render(40)[0]?.trimEnd()).toBe("out closed");
  });

  it("sets renderShell", () => {
    expect(piTool({ ...baseSpec, renderShell: "self" }).renderShell).toBe("self");
    expect(piTool(baseSpec).renderShell).toBeUndefined();
  });

  it("passes outputPad and pads self-shell lines by it", () => {
    const pads: number[] = [];
    const long = "x".repeat(100);
    const spec: ToolSpec<unknown, unknown> = {
      ...baseSpec,
      renderShell: "self",
      renderCall: (_params, _theme, state) => {
        pads.push(state.outputPad);
        return `head\n${long}`;
      },
      renderResult: () => "",
    };

    const padded = piTool(spec)
      .renderCall({}, theme, context({ outputPad: 1 }))
      .render(40)
      .map(stripVTControlCharacters);
    const flush = piTool(spec)
      .renderCall({}, theme, context({ outputPad: 0 }))
      .render(40)
      .map(stripVTControlCharacters);
    const empty = piTool(spec).renderResult(piResult(""), options, theme, context()).render(40);
    const boxed = piTool({ ...spec, renderShell: "default" }).renderCall({}, theme, context());

    expect(pads).toEqual([1, 0, 1]);
    expect(padded).toHaveLength(2);
    expect(padded[0]).toBe(" head");
    expect(padded.every((line) => line.startsWith(" ") && visibleWidth(line) <= 39)).toBe(true);
    expect(padded[1]?.endsWith("…")).toBe(true);
    expect(flush[0]).toBe("head");
    expect(visibleWidth(flush[1] ?? "")).toBe(40);
    expect(flush[1]?.endsWith("…")).toBe(true);
    expect(empty).toEqual([]);
    expect(boxed).toBeInstanceOf(Text);
  });

  it("calls a width-function render with the width minus outputPad on both sides on every render", () => {
    const widths: number[] = [];
    const spec: ToolSpec<unknown, unknown> = {
      ...baseSpec,
      renderShell: "self",
      renderResult: () => (width) => {
        widths.push(width);
        return width < 50 ? "" : `head\n${"y".repeat(width + 5)}`;
      },
    };
    const component = piTool(spec).renderResult(piResult("x"), options, theme, context({ outputPad: 1 }));

    const wide = component.render(80).map(stripVTControlCharacters);
    const narrow = component.render(40);
    const flush = piTool(spec)
      .renderResult(piResult("x"), options, theme, context({ outputPad: 0 }))
      .render(60);
    const boxed = piTool({ ...spec, renderShell: "default" })
      .renderResult(piResult("x"), options, theme, context())
      .render(60)
      .map(stripVTControlCharacters);

    expect(widths).toEqual([78, 38, 60, 60]);
    expect(wide[0]).toBe(" head");
    expect(visibleWidth(wide[1] ?? "")).toBe(79);
    expect(wide[1]?.endsWith("…")).toBe(true);
    expect(narrow).toEqual([]);
    expect(flush).toHaveLength(2);
    expect(boxed[0]?.trimEnd()).toBe("head");
  });
});

type Phase = "partial" | "final" | "error";

/** pi's own tool row for `definition` after `phase`, rendered at `width`. */
const toolRow = (definition: ToolDefinition, phase: Phase, width = 40) => {
  const component = new ToolExecutionComponent(
    "probe",
    "call-7",
    {},
    {},
    definition,
    { requestRender() {} } as never,
    "/repo",
  );

  component.markExecutionStarted();
  component.updateResult(
    { content: [{ type: "text", text: "body" }], ...(phase === "error" ? { isError: true } : {}) } as never,
    phase === "partial",
  );

  return component.render(width);
};

const BACKGROUND = new RegExp(`${String.fromCharCode(27)}\\[48;[0-9;]*m`);

const background = (line: string | undefined) => line?.match(BACKGROUND)?.[0];

/** The background pi itself gives a native (default-shell) tool box in each phase. */
const native = (phase: Phase) =>
  background(
    toolRow(toPiTool({ ...baseSpec, renderCall: () => "", renderResult: (result) => result.text }), phase)[1],
  );

const boxed = (tone: () => ToolTone | undefined, phase: Phase, renderCall = () => "") =>
  toolRow(
    toPiTool<unknown, unknown>({
      ...baseSpec,
      renderShell: "box",
      renderCall,
      renderResult: (result) => `${result.text}\n${"z".repeat(60)}`,
      renderTone: () => tone(),
    }),
    phase,
  );

describe("toPiTool box shell", () => {
  it("hands pi the self shell", () => {
    expect(piTool({ ...baseSpec, renderShell: "box" }).renderShell).toBe("self");
  });

  it("draws pi's tool box with the background of the chosen tone, like a native tool", () => {
    const tones = { pending: native("partial"), success: native("final"), error: native("error") };

    expect(new Set(Object.values(tones)).size).toBe(3);
    expect(Object.values(tones).every((bg) => bg !== undefined)).toBe(true);

    (["pending", "success", "error"] as const).forEach((tone) => {
      const lines = boxed(() => tone, "final");
      const plain = lines.map(stripVTControlCharacters);

      expect(plain[0]).toBe("");
      expect(lines.slice(1).every((line) => background(line) === tones[tone])).toBe(true);
      expect(plain.slice(1).map((line) => line.trimEnd())).toEqual(["", " body", ` ${"z".repeat(37)}…`, ""]);
      expect(plain.slice(1).every((line) => visibleWidth(line) === 40)).toBe(true);
    });
  });

  it("falls back to pi's rule when renderTone gives no tone", () => {
    (["partial", "final", "error"] as const).forEach((phase) => {
      expect(background(boxed(() => undefined, phase)[1])).toBe(native(phase));
    });
  });

  it("draws no box for an empty render", () => {
    const lines = boxed(() => "pending", "final");
    const withCall = boxed(
      () => "pending",
      "final",
      () => "call",
    );

    expect(lines).toHaveLength(5);
    expect(withCall).toHaveLength(8);
  });

  it("passes the render state and the result to renderTone and reuses the box", () => {
    const seen: [boolean, string | undefined][] = [];
    const tool = piTool({
      ...baseSpec,
      renderShell: "box",
      renderResult: () => "x",
      renderTone: (state, result) => {
        seen.push([state.isPartial, result?.text]);
        return undefined;
      },
    });

    const first = tool.renderResult(piResult("out"), options, theme, context({ isPartial: true }));
    const second = tool.renderResult(piResult("out"), options, theme, context({ lastComponent: first }));

    expect(seen).toEqual([
      [true, "out"],
      [false, "out"],
    ]);
    expect(second).toBe(first);
  });
});

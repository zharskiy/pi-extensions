import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolRenderState, ToolResult, ToolSpec } from "../../adapter/contract.ts";
import { type PiToolRenderContext, toPiTool } from "../../adapter/pi-tools.ts";

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
  renderShell?: "default" | "self";
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
});

import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { piRenderContext, plainPiTheme } from "../../../test/framework/pi/index.ts";
import type { ToolRenderState, ToolResult, ToolSpec } from "../index.ts";
import { type PiToolRenderContext, toPiTool } from "../tools/tool-bridge.ts";

initTheme("dark", false);

const theme = plainPiTheme;

const invalidate = () => {};

const context = (patch: Partial<PiToolRenderContext> = {}) => piRenderContext({ invalidate, ...patch });

type Renderers = {
  renderShell?: "self";
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
    onUpdate: unknown,
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
    expect(states.map((state) => state.isError)).toEqual([true, true]);
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

    tool.renderCall({ flag: true }, theme, context({ args: { flag: true } }));
    tool.renderResult(piResult("x"), options, theme, context({ args: { flag: true } }));

    expect(seen).toEqual([{ flag: true }, { flag: true }]);
  });

  it("passes pi's isError through the result and the state renderResult receives", () => {
    const seen: [ToolResult<unknown>, boolean][] = [];
    const tool = piTool({
      ...baseSpec,
      renderResult: (result, state) => {
        seen.push([result, state.isError]);
        return "";
      },
    });

    tool.renderResult(piResult("bad", { isError: true }), options, theme, context({ isError: true }));
    tool.renderResult(piResult("fine"), options, theme, context());

    expect(seen.map(([result, isError]) => [result.isError ?? false, isError])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(seen[0]?.[0].text).toBe("bad");
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

  it("renders a width-function render as text at the full width", () => {
    const widths: number[] = [];
    const spec: ToolSpec<unknown, unknown> = {
      ...baseSpec,
      renderResult: () => (width) => {
        widths.push(width);
        return `head ${width}`;
      },
    };

    const lines = piTool(spec)
      .renderResult(piResult("x"), options, theme, context())
      .render(60)
      .map(stripVTControlCharacters);

    expect(widths).toEqual([60]);
    expect(lines[0]?.trimEnd()).toBe("head 60");
  });
});

describe("toPiTool row shell", () => {
  it("hands pi a self shell, puts each line after the output pad and cuts it to the width", () => {
    const widths: number[] = [];
    const tool = piTool<unknown, unknown>({
      ...baseSpec,
      renderShell: "row",
      renderCall: () => (width) => {
        widths.push(width);
        return `✓ probe ${"x".repeat(width)}`;
      },
      renderResult: () => "",
    });

    expect(tool.renderShell).toBe("self");

    const padded = tool
      .renderCall({}, theme, context({ outputPad: 1 }))
      .render(30)
      .map(stripVTControlCharacters);
    const flush = tool
      .renderCall({}, theme, context({ outputPad: 0 }))
      .render(30)
      .map(stripVTControlCharacters);

    expect(widths).toEqual([29, 30]);
    expect(padded).toEqual([` ✓ probe ${"x".repeat(18)}...`]);
    expect(flush).toEqual([`✓ probe ${"x".repeat(19)}...`]);
    expect(tool.renderResult(piResult("x"), options, theme, context()).render(30)).toEqual([]);
  });

  it("lets the row call see the latest result, its duration and an abort when it is drawn", () => {
    const states: ToolRenderState[] = [];
    const tool = piTool<unknown, unknown>({
      ...baseSpec,
      renderShell: "row",
      renderCall: (_params, _theme, state) => {
        states.push(state);
        return `✓ probe${state.result ? ` · ${state.result.text}` : ""}`;
      },
      renderResult: () => "",
    });
    const shared = context({ state: {}, isError: true });
    const call = tool.renderCall({}, theme, shared);

    tool.renderResult(piResult("Operation aborted"), options, theme, shared);

    expect(call.render(40).map(stripVTControlCharacters)).toEqual([" ✓ probe · Operation aborted"]);
    expect(states.at(-1)).toMatchObject({
      aborted: true,
      result: { text: "Operation aborted" },
    });
  });

  it("draws the row with the blank line pi puts between tool rows and no tool background", () => {
    const tool = piTool<unknown, unknown>({
      ...baseSpec,
      renderShell: "row",
      renderCall: () => "✓ probe",
      renderResult: () => "  ↳ done",
    });
    const component = new ToolExecutionComponent(
      "probe",
      "call-1",
      {},
      {},
      tool as unknown as ToolDefinition,
      { requestRender: () => {} } as never,
      "/repo",
    );

    component.updateResult({ content: [{ type: "text", text: "x" }], isError: false } as never);

    expect(component.render(40).map((line) => stripVTControlCharacters(line).trimEnd())).toEqual([
      "",
      " ✓ probe",
      "   ↳ done",
    ]);
  });
});

describe("toPiTool declaration fields", () => {
  it("forwards prompt guidelines and execution mode, and exposes a model-only tool as pi's model-only", () => {
    const tool = toPiTool({
      ...baseSpec,
      promptSnippet: "Probe things",
      promptGuidelines: ["Probe first."],
      executionMode: "sequential",
      modelOnly: true,
    });

    expect(tool).toMatchObject({
      promptSnippet: "Probe things",
      promptGuidelines: ["Probe first."],
      executionMode: "sequential",
      exposure: "model-only",
    });
  });

  it("leaves them unset when the spec has none", () => {
    const tool = toPiTool(baseSpec);

    expect([tool.promptGuidelines, tool.executionMode, tool.exposure]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

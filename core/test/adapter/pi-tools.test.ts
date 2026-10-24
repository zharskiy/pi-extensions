import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  mixColors,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolRenderState, ToolResult, ToolSpec } from "../../adapter/contract.ts";
import { type PiToolRenderContext, themeLike, toPiTool } from "../../adapter/pi-tools.ts";

initTheme("dark", false);

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_token: string, text: string) => text,
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
    outputPad: 1,
    ...patch,
  }) as PiToolRenderContext;

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
    expect(states.map((state) => [state.toolCallId, state.isError])).toEqual([
      ["call-7", true],
      ["call-7", true],
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

  it("passes pi's tool call id into the execute context", async () => {
    const seen: (string | undefined)[] = [];
    const tool = piTool({
      ...baseSpec,
      execute: async (_params, ctx) => {
        seen.push(ctx.toolCallId);
        return { text: "done" };
      },
    });

    await tool.execute("call-7", {}, undefined, () => {}, {});

    expect(seen).toEqual(["call-7"]);
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
    const shared = context({ state: {}, isError: true, durationMs: 7_000 });
    const call = tool.renderCall({}, theme, shared);

    tool.renderResult(piResult("Operation aborted"), options, theme, shared);

    expect(call.render(40).map(stripVTControlCharacters)).toEqual([" ✓ probe · Operation aborted"]);
    expect(states.at(-1)).toMatchObject({
      durationMs: 7_000,
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

describe("themeLike colours", () => {
  it("paints role tokens with pi's matching theme colours", () => {
    const recording = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Theme;
    const like = themeLike(recording);

    expect(
      (["warning", "accent", "border", "thinkingOff", "thinkingXhigh"] as const).map((token) =>
        like.fg(token, "x"),
      ),
    ).toEqual(["<warning>x", "<accent>x", "<border>x", "<thinkingOff>x", "<thinkingXhigh>x"]);
  });

  it("paints the thinking-level tokens with pi's thinking colours", () => {
    const recording = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Theme;
    const like = themeLike(recording);
    const levels = ["Off", "Minimal", "Low", "Medium", "High", "Xhigh"] as const;

    expect(levels.map((level) => like.fg(`thinking${level}`, "x"))).toEqual(
      levels.map((level) => `<thinking${level}>x`),
    );
  });

  it("styles italic and inverse text through pi's theme", async () => {
    const live = await themeModule();
    const like = themeLike(live.theme);

    expect(like.italic("x")).toBe(live.theme.italic("x"));
    expect(like.inverse("x")).toBe(live.theme.inverse("x"));
  });
});

const themeModule = async () =>
  (await import(
    new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  )) as { theme: Theme; loadThemeFromPath(path: string, mode: string): Theme };

describe("themeLike panels", () => {
  const withSuccessBg = async (value: string) => {
    const { loadThemeFromPath } = await themeModule();
    const source = new URL(
      "modes/interactive/theme/dark.json",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const json = JSON.parse(readFileSync(source, "utf8"));
    const file = join(mkdtempSync(join(tmpdir(), "pi-theme-")), "probe.json");

    writeFileSync(
      file,
      JSON.stringify({ ...json, name: "probe", colors: { ...json.colors, toolSuccessBg: value } }),
    );

    return themeLike(loadThemeFromPath(file, "truecolor"));
  };

  it("reports panels when the tool success background has a colour", async () => {
    expect((await withSuccessBg("#103010")).panels).toBe(true);
  });

  it("reports no panels when the tool success background is the terminal default", async () => {
    expect((await withSuccessBg("")).panels).toBe(false);
  });
});

describe("themeLike backgrounds", () => {
  const live = async () => {
    const module = await import(
      new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    );

    return module.theme as Theme;
  };

  it("paints diff lines on pi's tool success and error backgrounds", () => {
    const styled: unknown[] = [];
    const recording = {
      style: (text: string, options: unknown) => {
        styled.push(options);
        return text;
      },
    } as unknown as Theme;

    themeLike(recording).bg("added", "x");
    themeLike(recording).bg("removed", "x");

    expect(styled).toEqual([{ bg: "toolSuccessBg" }, { bg: "toolErrorBg" }]);
  });

  it("paints changed words on a background mixed from the line background and the diff colour", async () => {
    const theme = await live();
    const like = themeLike(theme);
    const word = mixColors(theme.colors.toolSuccessBg, theme.colors.toolDiffAdded, 0.4);

    expect(like.bg("added", "x")).toBe(theme.style("x", { bg: "toolSuccessBg" }));
    expect(like.bg("addedWord", "x")).toBe(theme.style("x", { bg: word }));
    expect(like.bg("removedWord", "x")).not.toBe(like.bg("removed", "x"));
    expect(stripVTControlCharacters(like.bg("removedWord", "x"))).toBe("x");
  });
});

describe("themeLike text metrics", () => {
  it("measures and truncates with pi-tui", () => {
    const like = themeLike(theme);

    expect(like.width("日本")).toBe(visibleWidth("日本"));
    expect(like.width("a\tb")).toBe(visibleWidth("a\tb"));
    expect(like.width("🚀 \x1b[31mab\x1b[0m")).toBe(visibleWidth("🚀 \x1b[31mab\x1b[0m"));
    expect(like.truncate("Map the auth module", 8)).toBe("Map t...");
    expect(like.truncate("日本語テキスト", 5)).toBe("日...");
    expect(like.truncate("short", 10)).toBe("short");
    expect(like.truncate("x", 0)).toBe("");
    expect(like.truncate("Map the auth module", 12).endsWith("...")).toBe(true);
    expect(like.truncate("Map the auth module", 12)).not.toContain("…");
  });

  it("keeps pi's resets around the ellipsis of a painted line", () => {
    const painted = "\x1b[31mMap the auth module\x1b[0m";

    expect(themeLike(theme).truncate(painted, 8)).toBe(truncateToWidth(painted, 8, "..."));
  });

  it("wraps with pi-tui at word boundaries and keeps at least one column", () => {
    const like = themeLike(theme);
    const painted = "\x1b[31mMap the auth module and its callers\x1b[0m";

    expect(like.wrap("Map the auth module", 8)).toEqual(["Map the", "auth", "module"]);
    expect(like.wrap(painted, 10)).toEqual(wrapTextWithAnsi(painted, 10));
    expect(like.wrap("ab", 0)).toEqual(wrapTextWithAnsi("ab", 1));
    expect(like.wrap("", 10)).toEqual([""]);
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

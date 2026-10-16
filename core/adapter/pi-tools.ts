import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  ThemeLike,
  ThemeToken,
  ToolRender,
  ToolRenderState,
  ToolResult,
  ToolSpec,
  ToolTone,
} from "./contract.ts";

const ESC = "\x1b";

export const textMetrics: Pick<ThemeLike, "width" | "truncate" | "wrap"> = {
  width: visibleWidth,
  truncate: (text, cols) => {
    const cut = truncateToWidth(text, cols, "…");

    return text.includes(ESC) ? cut : stripVTControlCharacters(cut);
  },
  wrap: (text, cols) => wrapTextWithAnsi(text, Math.max(1, cols)),
};

export const fitLines = (lines: string[], width: number) =>
  lines.map((line) => truncateToWidth(line, width, "…"));

const PI_COLORS = {
  accent: "accent",
  muted: "muted",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
  text: "text",
  comment: "syntaxComment",
  keyword: "syntaxKeyword",
  function: "syntaxFunction",
  string: "syntaxString",
  number: "syntaxNumber",
  type: "syntaxType",
  heading: "mdHeading",
} as const satisfies Record<ThemeToken, Parameters<Theme["fg"]>[0]>;

export const piColor = (token: ThemeToken) => PI_COLORS[token];

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(piColor(token), text),
  bold: (text) => theme.bold(text),
  ...textMetrics,
});

class WidthText implements Component {
  private source: (width: number) => string;
  private readonly text = new Text("", 0, 0);

  constructor(source: (width: number) => string) {
    this.source = source;
  }

  set(source: (width: number) => string) {
    this.source = source;
  }

  render(width: number): string[] {
    this.text.setText(this.source(width));

    return this.text.render(width);
  }

  invalidate() {
    this.text.invalidate();
  }
}

const textComponent = (previous: unknown, text: ToolRender): Component => {
  if (typeof text === "function") {
    if (previous instanceof WidthText) {
      previous.set(text);
      return previous;
    }

    return new WidthText(text);
  }

  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }

  return new Text(text, 0, 0);
};

const splitLines = (text: string) => (text === "" ? [] : text.split("\n"));

class CutLines implements Component {
  private readonly source: ToolRender;

  constructor(source: ToolRender) {
    this.source = source;
  }

  render(width: number): string[] {
    const text = typeof this.source === "function" ? this.source(width) : this.source;

    return fitLines(splitLines(text), width);
  }

  invalidate() {}
}

export const toPiResult = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

const fromPiResult = (result: {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}): ToolResult => ({
  text: result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n"),
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

export type PiToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

type RenderContext = Pick<
  PiToolRenderContext,
  "toolCallId" | "expanded" | "isPartial" | "isError" | "args" | "outputPad" | "invalidate" | "lastComponent"
>;

const renderState = (context: RenderContext): ToolRenderState => ({
  toolCallId: context.toolCallId,
  expanded: context.expanded,
  isPartial: context.isPartial,
  isError: context.isError,
  args: context.args,
  invalidate: context.invalidate,
});

const TONE_BG = {
  pending: "toolPendingBg",
  success: "toolSuccessBg",
  error: "toolErrorBg",
} as const satisfies Record<ToolTone, Parameters<Theme["bg"]>[0]>;

const piTone = (context: RenderContext): ToolTone =>
  context.isPartial ? "pending" : context.isError ? "error" : "success";

const reuseBox = (box: Box, pad: number, bg: (line: string) => string) => {
  box.clear();
  box.setBgFn(bg);
  box.setPaddingX(pad);

  return box;
};

const toolBox = (theme: Theme, context: RenderContext, text: ToolRender, tone: ToolTone): Component => {
  const pad = context.outputPad;
  const bg = (line: string) => theme.bg(TONE_BG[tone], line);
  const box =
    context.lastComponent instanceof Box ? reuseBox(context.lastComponent, pad, bg) : new Box(pad, 1, bg);

  box.addChild(new CutLines(text));

  return box;
};

const shellComponent = <P, D>(
  spec: ToolSpec<P, D>,
  theme: Theme,
  context: RenderContext,
  text: ToolRender,
  result?: ToolResult<D>,
): Component => {
  if (spec.renderShell === "box") {
    return toolBox(theme, context, text, spec.renderTone?.(renderState(context), result) ?? piTone(context));
  }

  return textComponent(context.lastComponent, text);
};

export const toPiTool = <P, D>(spec: ToolSpec<P, D>, onContext: (ctx: ExtensionContext) => void = () => {}) =>
  ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: Type.Unsafe<P>(spec.parameters),
    executionMode: spec.executionMode,
    exposure: spec.modelOnly ? "model-only" : undefined,
    renderShell: spec.renderShell === "box" ? "self" : undefined,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate:
        | ((update: { content: { type: "text"; text: string }[]; details: D | undefined }) => void)
        | undefined,
      ctx: ExtensionContext,
    ) => {
      onContext(ctx);

      const result = await spec.execute(params as P, {
        signal,
        toolCallId,
        update: (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
      });

      return toPiResult(result) as never;
    },
    renderCall: spec.renderCall
      ? (args: unknown, theme: Theme, context: RenderContext) =>
          shellComponent(
            spec,
            theme,
            context,
            spec.renderCall?.(args as P, themeLike(theme), renderState(context)) ?? "",
          )
      : undefined,
    renderResult: spec.renderResult
      ? (result: unknown, _options: { expanded: boolean }, theme: Theme, context: RenderContext) => {
          const converted = fromPiResult(result as never) as ToolResult<D>;

          return shellComponent(
            spec,
            theme,
            context,
            spec.renderResult?.(converted, renderState(context), themeLike(theme)) ?? "",
            converted,
          );
        }
      : undefined,
  }) as unknown as ToolDefinition;

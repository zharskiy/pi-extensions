import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  mixColors,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  BgToken,
  ThemeLike,
  ThemeToken,
  ToolRender,
  ToolRenderState,
  ToolResult,
  ToolSpec,
} from "./contract.ts";
import { abortedText, recordPad, rowComponent, slotFor } from "./pi-row-component.ts";

const ESC = "\x1b";

export const textMetrics: Pick<ThemeLike, "width" | "truncate" | "wrap"> = {
  width: visibleWidth,
  truncate: (text, cols) => {
    const cut = truncateToWidth(text, cols, "...");

    return text.includes(ESC) ? cut : stripVTControlCharacters(cut);
  },
  wrap: (text, cols) => wrapTextWithAnsi(text, Math.max(1, cols)),
};

export const fitLines = (lines: string[], width: number) =>
  lines.map((line) => truncateToWidth(line, width, "..."));

const PI_COLORS = {
  accent: "accent",
  border: "border",
  borderAccent: "borderAccent",
  muted: "muted",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
  text: "text",
  thinkingOff: "thinkingOff",
  thinkingMinimal: "thinkingMinimal",
  thinkingLow: "thinkingLow",
  thinkingMedium: "thinkingMedium",
  thinkingHigh: "thinkingHigh",
  thinkingXhigh: "thinkingXhigh",
  thinkingMax: "thinkingMax",
} as const satisfies Record<ThemeToken, Parameters<Theme["fg"]>[0]>;

export const piColor = (token: ThemeToken) => PI_COLORS[token];

const WORD_MIX = 0.4;

const NO_BG = "\x1b[49m";

const LINE_BGS = { added: "toolSuccessBg", removed: "toolErrorBg" } as const;

const WORD_BGS = {
  addedWord: ["toolSuccessBg", "toolDiffAdded"],
  removedWord: ["toolErrorBg", "toolDiffRemoved"],
} as const;

const piBg = (theme: Theme, token: BgToken) => {
  if (token === "added" || token === "removed") {
    return LINE_BGS[token];
  }

  const [line, word] = WORD_BGS[token];

  return mixColors(theme.colors[line], theme.colors[word], WORD_MIX);
};

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(piColor(token), text),
  bg: (token, text) => theme.style(text, { bg: piBg(theme, token) }),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  inverse: (text) => theme.inverse(text),
  get panels() {
    return theme.getBgAnsi("toolSuccessBg") !== NO_BG;
  },
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

export const toPiResult = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

export const fromPiResult = (result: {
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
  | "toolCallId"
  | "expanded"
  | "isPartial"
  | "isError"
  | "args"
  | "outputPad"
  | "invalidate"
  | "lastComponent"
  | "durationMs"
  | "state"
>;

const latestResult = (context: RenderContext) => slotFor(context.state).result as ToolResult | undefined;

const renderState = (
  name: string,
  context: RenderContext,
  result = latestResult(context),
): ToolRenderState => ({
  toolCallId: context.toolCallId,
  expanded: context.expanded,
  isPartial: context.isPartial,
  isError: context.isError,
  args: context.args,
  aborted: context.isError && result !== undefined && abortedText(result.text, name),
  ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }),
  ...(result ? { result } : {}),
  invalidate: context.invalidate,
});

const shellComponent = <P, D>(
  spec: ToolSpec<P, D>,
  context: RenderContext,
  render: () => ToolRender,
): Component => {
  if (spec.renderShell === "row") {
    recordPad(context.outputPad);

    return rowComponent(context.lastComponent, {
      lines: (width) => {
        const text = render();

        return splitLines(typeof text === "function" ? text(width) : text);
      },
      pad: context.outputPad,
    });
  }

  return textComponent(context.lastComponent, render());
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
    renderShell: spec.renderShell === "row" ? "self" : undefined,
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
            context,
            () => spec.renderCall?.(args as P, themeLike(theme), renderState(spec.name, context)) ?? "",
          )
      : undefined,
    renderResult: spec.renderResult
      ? (result: unknown, _options: { expanded: boolean }, theme: Theme, context: RenderContext) => {
          const converted = fromPiResult({
            ...(result as object),
            isError: context.isError,
          } as never) as ToolResult<D>;

          slotFor(context.state).result = converted;

          return shellComponent(
            spec,
            context,
            () =>
              spec.renderResult?.(converted, renderState(spec.name, context, converted), themeLike(theme)) ??
              "",
          );
        }
      : undefined,
  }) as unknown as ToolDefinition;

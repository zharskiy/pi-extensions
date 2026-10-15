import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolRender, ToolRenderState, ToolResult, ToolSpec, ToolTone } from "./contract.ts";
import { PaddedLines, textComponent, themeLike } from "./pi-components.ts";

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
  outputPad: context.outputPad,
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

  box.addChild(new PaddedLines(text));

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
    parameters: Type.Unsafe<P>(spec.parameters),
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

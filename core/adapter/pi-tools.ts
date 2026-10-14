import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolRender, ToolRenderState, ToolResult, ToolSpec, ToolTone } from "./contract.ts";
import { padLines, textComponent, themeLike } from "./pi-components.ts";

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

/** pi's `ToolRenderContext` (not exported from the package root). */
export type PiToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

type RenderContext = Pick<
  PiToolRenderContext,
  | "toolCallId"
  | "expanded"
  | "isPartial"
  | "executionStarted"
  | "isError"
  | "args"
  | "durationMs"
  | "outputPad"
  | "invalidate"
  | "lastComponent"
>;

const renderState = (context: RenderContext): ToolRenderState => ({
  toolCallId: context.toolCallId,
  expanded: context.expanded,
  isPartial: context.isPartial,
  executionStarted: context.executionStarted,
  isError: context.isError,
  args: context.args,
  durationMs: context.durationMs,
  outputPad: context.outputPad,
  invalidate: context.invalidate,
});

const TONE_BG = {
  pending: "toolPendingBg",
  success: "toolSuccessBg",
  error: "toolErrorBg",
} as const satisfies Record<ToolTone, Parameters<Theme["bg"]>[0]>;

/** pi's own colour rule for a tool box (`ToolExecutionComponent.updateDisplay`). */
const piTone = (context: RenderContext): ToolTone =>
  context.isPartial ? "pending" : context.isError ? "error" : "success";

const lineSource = (text: ToolRender) =>
  typeof text === "function" ? text : text === "" ? [] : text.split("\n");

/** pi's tool `Box` (padding `outputPad` x 1, background `tone`) around the lines; draws nothing when they are empty. Reuses `previous` when it is a `Box`. */
const toolBox = (theme: Theme, context: RenderContext, text: ToolRender, tone: ToolTone): Component => {
  const pad = context.outputPad ?? 1;
  const bg = (line: string) => theme.bg(TONE_BG[tone], line);
  const box = context.lastComponent instanceof Box ? context.lastComponent : new Box(pad, 1, bg);

  box.clear();
  box.setBgFn(bg);
  box.setPaddingX(pad);
  box.addChild(padLines(lineSource(text), 0));

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

  if (spec.renderShell !== "self") {
    return textComponent(context.lastComponent, text);
  }

  return padLines(lineSource(text), context.outputPad ?? 1, context.lastComponent);
};

export const toPiTool = <P, D>(spec: ToolSpec<P, D>, onContext: (ctx: ExtensionContext) => void = () => {}) =>
  ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    parameters: Type.Unsafe<P>(spec.parameters),
    renderShell: spec.renderShell === "box" ? "self" : spec.renderShell,
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
          const final = context.isError ? { ...converted, isError: true } : converted;

          return shellComponent(
            spec,
            theme,
            context,
            spec.renderResult?.(final, renderState(context), themeLike(theme)) ?? "",
            final,
          );
        }
      : undefined,
  }) as unknown as ToolDefinition;

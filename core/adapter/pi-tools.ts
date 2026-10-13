import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolRenderState, ToolResult, ToolSpec } from "./contract.ts";
import { padLines, textComponent, themeLike } from "./pi-ui.ts";

const toPiResult = (result: ToolResult) => ({
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

const shellComponent = (shell: ToolSpec["renderShell"], context: RenderContext, text: string): Component =>
  shell === "self"
    ? padLines(text === "" ? [] : text.split("\n"), context.outputPad ?? 1, context.lastComponent)
    : textComponent(context.lastComponent, text);

export const toPiTool = <P, D>(spec: ToolSpec<P, D>, onContext: (ctx: ExtensionContext) => void = () => {}) =>
  ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    parameters: Type.Unsafe<P>(spec.parameters),
    renderShell: spec.renderShell,
    execute: async (
      _toolCallId: string,
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
        update: (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
      });

      return toPiResult(result) as never;
    },
    renderCall: spec.renderCall
      ? (args: unknown, theme: Theme, context: RenderContext) =>
          shellComponent(
            spec.renderShell,
            context,
            spec.renderCall?.(args as P, themeLike(theme), renderState(context)) ?? "",
          )
      : undefined,
    renderResult: spec.renderResult
      ? (result: unknown, _options: { expanded: boolean }, theme: Theme, context: RenderContext) => {
          const converted = fromPiResult(result as never) as ToolResult<D>;

          return shellComponent(
            spec.renderShell,
            context,
            spec.renderResult?.(
              context.isError ? { ...converted, isError: true } : converted,
              renderState(context),
              themeLike(theme),
            ) ?? "",
          );
        }
      : undefined,
  }) as unknown as ToolDefinition;

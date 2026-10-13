import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolResult, ToolSpec } from "./contract.ts";
import { textComponent, themeLike } from "./pi-ui.ts";

const toPiResult = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

const fromPiResult = (result: {
  content: { type: string; text?: string }[];
  details?: unknown;
}): ToolResult => ({
  text: result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n"),
  details: result.details,
});

export const toPiTool = <P, D>(spec: ToolSpec<P, D>, onContext: (ctx: ExtensionContext) => void = () => {}) =>
  ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    parameters: Type.Unsafe<P>(spec.parameters),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: { type: "text"; text: string }[]; details: never }) => void) | undefined,
      ctx: ExtensionContext,
    ) => {
      onContext(ctx);

      const result = await spec.execute(params as P, {
        signal,
        update: (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined as never }),
      });

      return toPiResult(result) as never;
    },
    renderCall: spec.renderCall
      ? (args: unknown, theme: Theme, context: { lastComponent?: unknown }) =>
          textComponent(context.lastComponent, spec.renderCall?.(args as P, themeLike(theme)) ?? "")
      : undefined,
    renderResult: spec.renderResult
      ? (
          result: unknown,
          options: { expanded: boolean },
          theme: Theme,
          context: { lastComponent?: unknown; invalidate: () => void },
        ) =>
          textComponent(
            context.lastComponent,
            spec.renderResult?.(
              fromPiResult(result as never) as ToolResult<D>,
              { expanded: options.expanded, invalidate: context.invalidate },
              themeLike(theme),
            ) ?? "",
          )
      : undefined,
  }) as unknown as ToolDefinition;

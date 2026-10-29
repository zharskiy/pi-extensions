import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { messageText } from "../runtime/message-text.ts";
import type { ToolRender, ToolRenderState, ToolResult, ToolSpec } from "../types/tools.ts";
import { themeLike } from "../ui/theme-bridge.ts";
import { abortedText, recordPad, rowComponent, slotFor } from "./row-component.ts";

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

const toPiResult = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

export const fromPiResult = (result: {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}): ToolResult => ({
  text: messageText(result.content),
  details: result.details,
  ...(result.isError ? { isError: true } : {}),
});

export type PiToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

type RenderContext = Pick<
  PiToolRenderContext,
  "expanded" | "isPartial" | "isError" | "args" | "outputPad" | "invalidate" | "lastComponent" | "state"
>;

const latestResult = (context: RenderContext) => slotFor(context.state).result as ToolResult | undefined;

const renderState = (
  name: string,
  context: RenderContext,
  result = latestResult(context),
): ToolRenderState => ({
  expanded: context.expanded,
  isPartial: context.isPartial,
  isError: context.isError,
  args: context.args,
  aborted: context.isError && result !== undefined && abortedText(result.text, name),
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
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      onContext(ctx);

      const result = await spec.execute(params as P, { signal });

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

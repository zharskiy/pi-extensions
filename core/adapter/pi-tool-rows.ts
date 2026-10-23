import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Host, ThemeLike, ToolCallView, ToolRows } from "./contract.ts";
import { recordPad, rowComponent, toolRowsRecord } from "./pi-row-component.ts";
import { fromPiResult, type PiToolRenderContext, themeLike } from "./pi-tools.ts";

export const BUILTIN_TOOLS: readonly string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

type PiResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

type ResultOptions = Parameters<NonNullable<ToolRenderers["renderResult"]>>[1];

const imageCount = (result: PiResult) =>
  (result.content as { type: string }[]).filter((part) => part.type === "image").length;

const callView = (name: string, context: PiToolRenderContext, result?: PiResult): ToolCallView => ({
  name,
  args: context.args,
  argsComplete: context.argsComplete,
  started: context.executionStarted,
  isPartial: context.isPartial,
  isError: context.isError,
  expanded: context.expanded,
  cwd: context.cwd,
  ...(result ? { result: { ...fromPiResult(result as never), images: imageCount(result) } } : {}),
});

const probeView = (name: string): ToolCallView => ({
  name,
  args: {},
  argsComplete: false,
  started: false,
  isPartial: true,
  isError: false,
  expanded: false,
  cwd: "",
});

type BodySlot = { state: object; component?: Component };

const bodySlots = new WeakMap<object, BodySlot>();

const slotFor = (state: object) => {
  const slot = bodySlots.get(state) ?? { state: {} };

  bodySlots.set(state, slot);

  return slot;
};

const piBody = (
  base: ToolRenderers,
  result: PiResult,
  options: ResultOptions,
  theme: Theme,
  context: PiToolRenderContext,
) => {
  const slot = slotFor(context.state);

  try {
    slot.component = base.renderResult?.(result, options, theme, {
      ...context,
      state: slot.state,
      lastComponent: slot.component,
      outputPad: 0,
    });
  } catch {
    slot.component = undefined;
  }

  return slot.component;
};

const linesOf = (render: ((width: number, theme: ThemeLike) => string[]) | undefined, theme: ThemeLike) =>
  render ? (width: number) => render(width, theme) : () => [];

const keepsBase = (name: string, base: ToolRenderers | undefined) =>
  !BUILTIN_TOOLS.includes(name) &&
  (base?.renderShell === "self" || base?.renderCall !== undefined || base?.renderResult !== undefined);

export const rowRenderers = (
  rows: ToolRows | undefined,
  name: string,
  base: ToolRenderers | undefined,
): ToolRenderers | undefined => {
  if (!rows || keepsBase(name, base) || !rows(probeView(name))) {
    return base;
  }

  return {
    renderShell: "self",
    renderCall: (_args, theme, context) => {
      recordPad(context.outputPad);

      const row = rows(callView(name, context));

      return rowComponent(context.lastComponent, {
        lines: linesOf(row?.call, themeLike(theme)),
        pad: context.outputPad,
      });
    },
    renderResult: (result, options, theme, context) => {
      recordPad(context.outputPad);

      const row = rows(callView(name, context, result));
      const body =
        context.expanded && row?.piBody && base ? piBody(base, result, options, theme, context) : undefined;

      return rowComponent(context.lastComponent, {
        lines: linesOf(row?.result, themeLike(theme)),
        pad: context.outputPad,
        body,
        lead: `  ${theme.fg("dim", "⎿")}  `,
      });
    },
  };
};

export const applyToolRows = (name: string, base: ToolRenderers | undefined) =>
  rowRenderers(toolRowsRecord().rows, name, base);

export const toolRowsHost = (pi: Pick<ExtensionAPI, "registerToolRenderer">) => {
  const owner = {};

  return {
    registerToolRows: ((rows) => {
      const shared = toolRowsRecord();

      shared.rows = rows;
      shared.owner = owner;

      pi.registerToolRenderer((name, next) => rowRenderers(rows, name, next()));
    }) satisfies Host["registerToolRows"],
    release: () => {
      const shared = toolRowsRecord();

      if (shared.owner !== owner) {
        return;
      }

      shared.rows = undefined;
      shared.owner = undefined;
    },
  };
};

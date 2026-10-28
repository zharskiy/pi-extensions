import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Host } from "../types/host-capabilities.ts";
import type { ThemeLike } from "../types/theme.ts";
import type { RowLines, ToolCallView, ToolRow, ToolRows } from "../types/tools.ts";
import { childLead } from "../ui/row-layout.ts";
import { themeLike } from "../ui/theme-bridge.ts";
import {
  abortedText,
  abortNotice,
  type RowSlot,
  recordPad,
  rowComponent,
  slotFor,
  toolRowsRecord,
} from "./row-component.ts";
import { skillOfRead } from "./skill-reads.ts";
import { fromPiResult, type PiToolRenderContext } from "./tool-bridge.ts";

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

export type ToolLabel = (name: string) => string | undefined;

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export const mcpLabel: ToolLabel = (name) => {
  const match = MCP_NAME.exec(name);

  return match ? `${match[1]}/${match[2]}` : undefined;
};

const MCP_SOURCE = "builtin:mcp";

export const toolLabel = (pi: Pick<ExtensionAPI, "getAllTools">, name: string) => {
  try {
    const tool = pi.getAllTools().find((info) => info.name === name && info.sourceInfo.path === MCP_SOURCE);
    const server = tool?.namespace?.aliases?.[0];
    const prefix = `${tool?.namespace?.name}__`;

    if (server && name.startsWith(prefix)) {
      return `${server}/${name.slice(prefix.length)}`;
    }
  } catch {}

  return mcpLabel(name);
};

const callView = (
  name: string,
  context: PiToolRenderContext,
  result: PiResult | undefined,
  label: ToolLabel,
): ToolCallView => {
  const converted = result ? fromPiResult(result as never) : undefined;
  const tool = label(name);
  const skill = skillOfRead(name, context.args, context.cwd, homedir());
  const aborted = context.isError && converted !== undefined && abortedText(converted.text, name);

  return {
    name,
    args: context.args,
    argsComplete: context.argsComplete,
    started: context.executionStarted || result !== undefined,
    isPartial: context.isPartial,
    isError: context.isError,
    expanded: context.expanded,
    cwd: context.cwd,
    aborted,
    ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }),
    ...(tool ? { label: tool } : {}),
    ...(skill ? { skill } : {}),
    ...(converted && result
      ? {
          result: {
            ...converted,
            text: aborted && abortNotice(converted.text) ? "" : converted.text,
            images: imageCount(result),
          },
        }
      : {}),
  };
};

const probeView = (name: string): ToolCallView => ({
  name,
  args: {},
  argsComplete: false,
  started: false,
  isPartial: true,
  isError: false,
  expanded: false,
  cwd: "",
  aborted: false,
});

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

const baseContext = (context: PiToolRenderContext, slot: RowSlot): PiToolRenderContext => ({
  ...context,
  state: slot.state,
  lastComponent: undefined,
});

const fallback = (render: () => Component | undefined) => () => {
  try {
    return render();
  } catch {
    return undefined;
  }
};

const linesOf = (render: RowLines | undefined, theme: ThemeLike) =>
  render ? (width: number) => render(width, theme) : () => [];

const TIMING = /^(Took|Elapsed) \d/;

const timingFilter = (row: ToolRow | undefined) =>
  row?.dropTiming ? (line: string) => !TIMING.test(stripVTControlCharacters(line).trim()) : undefined;

const BUILTIN_SOURCE = "builtin";

export const piShipped = (pi: Pick<ExtensionAPI, "getAllTools">, name: string) => {
  try {
    return pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.source === BUILTIN_SOURCE);
  } catch {
    return false;
  }
};

const hasOwnRenderer = (base: ToolRenderers | undefined) =>
  base?.renderShell === "self" || base?.renderCall !== undefined || base?.renderResult !== undefined;

const keepsBase = (name: string, base: ToolRenderers | undefined, shipped: () => boolean) =>
  !BUILTIN_TOOLS.includes(name) && hasOwnRenderer(base) && !shipped();

export const rowRenderers = (
  rows: ToolRows | undefined,
  name: string,
  base: ToolRenderers | undefined,
  shipped: () => boolean = () => false,
  label: ToolLabel = mcpLabel,
): ToolRenderers | undefined => {
  if (!rows || keepsBase(name, base, shipped) || !rows(probeView(name))) {
    return base;
  }

  return {
    renderShell: "self",
    renderCall: (args, theme, context) => {
      recordPad(context.outputPad);

      const slot = slotFor(context.state);
      const like = themeLike(theme);

      return rowComponent(context.lastComponent, {
        lines: (width) =>
          linesOf(rows(callView(name, context, slot.result as PiResult, label))?.call, like)(width),
        pad: context.outputPad,
        fallback: fallback(() => base?.renderCall?.(args, theme, baseContext(context, slot))),
      });
    },
    renderResult: (result, options, theme, context) => {
      recordPad(context.outputPad);

      const slot = slotFor(context.state);

      slot.result = result;

      const like = themeLike(theme);
      const row = rows(callView(name, context, result, label));
      const body =
        context.expanded && row?.piBody && base ? piBody(base, result, options, theme, context) : undefined;

      return rowComponent(context.lastComponent, {
        lines: linesOf(row?.result, like),
        pad: context.outputPad,
        body,
        lead: childLead(like),
        filter: timingFilter(row),
        fallback: fallback(() => base?.renderResult?.(result, options, theme, baseContext(context, slot))),
      });
    },
  };
};

export const applyToolRows = (
  name: string,
  base: ToolRenderers | undefined,
  shipped: () => boolean = () => false,
) => rowRenderers(toolRowsRecord().rows, name, base, shipped);

const memoised = (label: ToolLabel): ToolLabel => {
  const known = new Map<string, string | undefined>();

  return (name) => {
    if (!known.has(name)) {
      known.set(name, label(name));
    }

    return known.get(name);
  };
};

export const toolRowsHost = (pi: Pick<ExtensionAPI, "registerToolRenderer" | "getAllTools">) => {
  const owner = {};
  const label = memoised((tool) => toolLabel(pi, tool));

  return {
    registerToolRows: ((rows) => {
      const shared = toolRowsRecord();

      shared.owners ??= new Map();
      shared.owners.delete(owner);
      shared.owners.set(owner, rows);
      shared.rows = rows;

      pi.registerToolRenderer((name, next) =>
        rowRenderers(rows, name, next(), () => piShipped(pi, name), label),
      );
    }) satisfies Host["registerToolRows"],
    release: () => {
      const shared = toolRowsRecord();

      if (!shared.owners?.delete(owner)) {
        return;
      }

      shared.rows = Array.from(shared.owners.values()).at(-1);
    },
  };
};

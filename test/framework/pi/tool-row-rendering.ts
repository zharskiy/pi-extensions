import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  initTheme,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { ToolRows } from "../../../platform/pi-adapter/index.ts";
import type { PiToolRenderContext } from "../../../platform/pi-adapter/tools/tool-bridge.ts";
import { rowRenderers, toolRowsHost } from "../../../platform/pi-adapter/tools/tool-rows.ts";
import { createTranscriptPane } from "../../../platform/pi-adapter/tools/transcript.ts";
import { initPiRenderTheme } from "./render-theme.ts";

const themes = await import(
  new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const APC = new RegExp(
  `${String.fromCharCode(27)}_[^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`,
  "g",
);

export const visible = (line: string) => line.replace(APC, "").replace(SGR, "");

type EditRender = { diff: string; outputPad: number; width: number };

export const piRenderContext = (patch: Partial<PiToolRenderContext> = {}) =>
  ({
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
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

export const renderEditDiff = (rows: ToolRows, { diff, outputPad, width }: EditRender) => {
  initTheme("dark", false);

  const renderers = rowRenderers(rows, "edit", createEditToolDefinition("/repo") as never);
  const lines =
    renderers
      ?.renderResult?.(
        { content: [{ type: "text", text: "ok" }], details: { diff } } as never,
        { expanded: true, isPartial: false },
        themes.theme as Theme,
        piRenderContext({ args: { path: "/repo/a.ts" }, expanded: true, outputPad }),
      )
      .render(width) ?? [];

  initPiRenderTheme();

  return lines;
};

export const renderPaneEditDiff = (rows: ToolRows, diff: string, width: number) => {
  const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

  host.registerToolRows(rows);

  const pane = createTranscriptPane({ requestRender: () => {} } as never, "/repo");
  const args = { path: "/repo/a.ts" };

  pane.sync([
    {
      kind: "assistant",
      text: "",
      toolCalls: [{ name: "edit", args }],
      raw: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: args }],
        stopReason: "toolUse",
        timestamp: 0,
      },
    },
    {
      kind: "tool",
      toolName: "edit",
      toolCallId: "call-1",
      text: "ok",
      isError: false,
      raw: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit",
        content: [{ type: "text", text: "ok" }],
        details: { diff },
        isError: false,
      },
    },
  ] as never);
  pane.setToolsExpanded(true);

  const lines = pane.render(width).map(visible);

  host.release();

  return lines;
};

export const piEditDiff = async (content: string, edits: { oldText: string; newText: string }[]) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-edit-"));

  writeFileSync(join(dir, "a.txt"), content);

  try {
    const edit = createEditToolDefinition(dir) as unknown as ToolDefinition;
    const result = await edit.execute(
      "call-1",
      { path: "a.txt", edits } as never,
      undefined,
      undefined,
      undefined as never,
    );

    return (result.details as { diff: string }).diff;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const PI_TOOLS: Record<string, (cwd: string) => unknown> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

export type ToolInput = {
  name: string;
  args: unknown;
  result?: string;
  details?: unknown;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  durationMs?: number;
  width: number;
  outputPad?: number;
  started?: boolean;
};

const dropLeadingBlanks = (lines: string[]) => {
  const start = lines.findIndex((line) => visible(line).trim() !== "");

  return start < 0 ? [] : lines.slice(start);
};

export const renderToolRows = (rows: ToolRows, input: ToolInput) => {
  initPiRenderTheme();

  const base = PI_TOOLS[input.name]?.("/repo") as ToolRenderers | undefined;
  const tool = new ToolExecutionComponent(
    input.name,
    "call-1",
    input.args,
    { outputPad: input.outputPad ?? 1 },
    rowRenderers(rows, input.name, base) as never,
    { requestRender: () => {} } as never,
    "/repo",
  );

  tool.setArgsComplete();

  if (input.started !== false) {
    tool.markExecutionStarted();
  }

  if (input.result !== undefined) {
    tool.updateResult(
      {
        content: [{ type: "text", text: input.result }],
        details: input.details,
        isError: input.isError ?? false,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      } as never,
      input.isPartial ?? false,
    );
  }

  tool.setExpanded(input.expanded ?? false);

  const painted = dropLeadingBlanks(tool.render(input.width));

  return { painted, lines: painted.map(visible) };
};

export type PaneInput = Omit<ToolInput, "isPartial" | "outputPad" | "started"> & {
  stopReason?: "aborted" | "error";
};

export const renderPaneToolRows = (rows: ToolRows, input: PaneInput) => {
  const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

  host.registerToolRows(rows);

  const pane = createTranscriptPane({ requestRender: () => {} } as never, "/repo");
  const stopReason = input.stopReason ?? "toolUse";
  const assistant = {
    kind: "assistant",
    text: "",
    toolCalls: [{ name: input.name, args: input.args }],
    raw: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: input.name, arguments: input.args }],
      stopReason,
      timestamp: 0,
    },
  };
  const tool = {
    kind: "tool",
    toolName: input.name,
    toolCallId: "call-1",
    text: input.result ?? "",
    isError: input.isError ?? false,
    raw: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: input.name,
      content: [{ type: "text", text: input.result ?? "" }],
      details: input.details,
      isError: input.isError ?? false,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    },
  };

  pane.sync(
    (stopReason === "toolUse" && input.result !== undefined ? [assistant, tool] : [assistant]) as never,
  );
  pane.setToolsExpanded(input.expanded ?? false);

  const lines = dropLeadingBlanks(pane.render(input.width)).map(visible);

  host.release();

  return lines;
};

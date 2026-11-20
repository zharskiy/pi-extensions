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
  type ToolDefinition,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { ToolRows, TranscriptItem } from "../../../platform/pi-adapter/index.ts";
import type { PiToolRenderContext } from "../../../platform/pi-adapter/tools/tool-bridge.ts";
import { rowRenderers, toolRowsHost } from "../../../platform/pi-adapter/tools/tool-rows.ts";
import { createTranscriptPane } from "../../../platform/pi-adapter/tools/transcript.ts";
import { plainText } from "../rendered-text.ts";
import { initPiRenderTheme, livePiTheme, piKeyHints } from "./render-theme.ts";

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
    ...piKeyHints,
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
        livePiTheme,
        piRenderContext({ args: { path: "/repo/a.ts" }, expanded: true, outputPad }),
      )
      .render(width) ?? [];

  initPiRenderTheme();

  return lines;
};

export const renderPaneEditDiff = (rows: ToolRows, diff: string, width: number) =>
  renderPaneToolRows(rows, {
    name: "edit",
    args: { path: "/repo/a.ts" },
    result: "ok",
    details: { diff },
    expanded: true,
    width,
  });

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

const dropLeadingBlanks = (lines: readonly string[]) => {
  const start = lines.findIndex((line) => plainText(line).trim() !== "");

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

  return { painted, lines: painted.map(plainText) };
};

export type PaneInput = Omit<ToolInput, "isPartial" | "outputPad" | "started"> & {
  stopReason?: "aborted" | "error";
};

export const renderPaneToolRows = (rows: ToolRows, input: PaneInput) => {
  const host = toolRowsHost({ registerToolRenderer: () => {} } as never);

  host.registerToolRows(rows);

  const pane = createTranscriptPane({ requestRender: () => {} } as never, "/repo");
  const stopReason = input.stopReason ?? "toolUse";
  const assistant: TranscriptItem = {
    kind: "assistant",
    raw: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: input.name, arguments: input.args }],
      stopReason,
      timestamp: 0,
    },
  };
  const tool: TranscriptItem = {
    kind: "tool",
    toolCallId: "call-1",
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

  pane.sync(stopReason === "toolUse" && input.result !== undefined ? [assistant, tool] : [assistant]);
  pane.setToolsExpanded(input.expanded ?? false);

  const lines = dropLeadingBlanks(pane.render(input.width)).map(plainText);

  host.release();

  return lines;
};

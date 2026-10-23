import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  initTheme,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolRows } from "../../adapter/contract.ts";
import { rowRenderers, toolRowsHost } from "../../adapter/pi-tool-rows.ts";
import type { PiToolRenderContext } from "../../adapter/pi-tools.ts";
import { createTranscriptPane } from "../../adapter/pi-transcript.ts";
import { initRenderTheme } from "./render-theme.ts";

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

export const renderExpandedEdit = (rows: ToolRows, { diff, outputPad, width }: EditRender) => {
  initTheme("dark", false);

  const renderers = rowRenderers(rows, "edit", createEditToolDefinition("/repo") as never);
  const lines =
    renderers
      ?.renderResult?.(
        { content: [{ type: "text", text: "ok" }], details: { diff } } as never,
        { expanded: true, isPartial: false },
        themes.theme as Theme,
        {
          args: { path: "/repo/a.ts" },
          toolCallId: "call-1",
          invalidate: () => {},
          lastComponent: undefined,
          state: {},
          cwd: "/repo",
          executionStarted: true,
          argsComplete: true,
          isPartial: false,
          expanded: true,
          showImages: false,
          isError: false,
          durationMs: undefined,
          outputPad,
        } as PiToolRenderContext,
      )
      .render(width) ?? [];

  initRenderTheme();

  return lines;
};

export const renderPaneEdit = (rows: ToolRows, diff: string, width: number) => {
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

import {
  AssistantMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createToolSearchExtension,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionFactory,
  getMarkdownTheme,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { AnyToolSpec } from "../types/tools.ts";
import type { TranscriptItem, TranscriptPane } from "../types/view.ts";
import { hiddenThinkingLabel, OSC133_ZONE_PREFIX } from "../ui/thinking-label.ts";
import { messageRendererFor } from "./entry-renderers.ts";
import { toPiTool } from "./tool-bridge.ts";
import { applyToolRows } from "./tool-rows.ts";

const toolDefinitionFactories: Record<string, (cwd: string) => object> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

type RawToolCall = { type: string; id: string; name: string; arguments: unknown };

type RawAssistant = { content: RawToolCall[]; stopReason: string; errorMessage?: string };

type Expandable = Component & { setExpanded(expanded: boolean): void };

export const capturePiRenderers = (
  factories: Record<string, () => ExtensionFactory>,
): Record<string, ToolRenderers> =>
  Object.fromEntries(
    Object.entries(factories).flatMap(([name, factory]) => {
      try {
        let captured: ToolRenderers | undefined;
        const stub = {
          registerTool: (definition: ToolRenderers) => {
            captured = definition;
          },
        } as unknown as ExtensionAPI;

        Promise.resolve(factory()(stub)).catch(() => {});

        if (!captured?.renderCall && !captured?.renderResult) {
          return [];
        }

        const { renderShell, renderCall, renderResult } = captured;

        return [[name, { renderShell, renderCall, renderResult }]];
      } catch {
        return [];
      }
    }),
  );

let piRenderers: Record<string, ToolRenderers> | undefined;

const defaultPiRenderers = () => {
  piRenderers ??= capturePiRenderers({
    codemode: createCodemodeExtension,
    tool_search: createToolSearchExtension,
  });

  return piRenderers;
};

export type TranscriptPaneOptions = {
  tools?: AnyToolSpec[];
};

export const createTranscriptPane = (
  tui: TUI,
  cwd: string,
  options: TranscriptPaneOptions = {},
): TranscriptPane => {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const definitions = new Map<string, object | undefined>();
  const expandables: Expandable[] = [];
  const renderers = defaultPiRenderers();
  let toolsExpanded = false;
  let synced = 0;
  let rendered = 0;

  const baseDefinition = (name: string): ToolRenderers | undefined => {
    const builtin = toolDefinitionFactories[name];

    if (builtin) {
      return builtin(cwd) as ToolRenderers;
    }

    const spec = options.tools?.find((tool) => tool.name === name);

    if (spec) {
      const { renderShell, renderCall, renderResult } = toPiTool(spec);

      return { renderShell, renderCall, renderResult };
    }

    return renderers[name];
  };

  const resolveDefinition = (name: string) => {
    const base = baseDefinition(name);

    return applyToolRows(name, base, () => base === renderers[name]);
  };

  const definitionFor = (name: string) => {
    if (!definitions.has(name)) {
      definitions.set(name, resolveDefinition(name));
    }

    return definitions.get(name);
  };

  const addExpandable = (component: Expandable) => {
    component.setExpanded(toolsExpanded);
    expandables.push(component);
    container.addChild(component);
  };

  const addToolCall = (call: RawToolCall, message: RawAssistant) => {
    const component = new ToolExecutionComponent(
      call.name,
      call.id,
      call.arguments,
      {},
      definitionFor(call.name) as never,
      tui,
      cwd,
    );

    addExpandable(component);

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";

      component.updateResult({ content: [{ type: "text", text }], isError: true });
      return;
    }

    component.markExecutionStarted();
    pendingTools.set(call.id, component);
  };

  const addItem = (item: TranscriptItem) => {
    if (item.kind === "user") {
      if (container.children.length > 0) {
        container.addChild(new Spacer(1));
      }

      container.addChild(new UserMessageComponent(item.text, getMarkdownTheme()));
      return;
    }

    if (item.kind === "assistant") {
      const message = item.raw as RawAssistant;

      container.addChild(
        new AssistantMessageComponent(item.raw as never, true, getMarkdownTheme(), hiddenThinkingLabel()),
      );

      message.content
        .filter((part) => part.type === "toolCall")
        .forEach((call) => {
          addToolCall(call, message);
        });

      return;
    }

    if (item.kind === "tool") {
      pendingTools.get(item.toolCallId)?.updateResult(item.raw as never);
      pendingTools.delete(item.toolCallId);
      return;
    }

    if ((item.raw as { display?: boolean }).display !== false) {
      const { customType } = item.raw as { customType: string };

      addExpandable(
        new CustomMessageComponent(item.raw as never, messageRendererFor(customType), getMarkdownTheme()),
      );
    }
  };

  const reset = () => {
    container.clear();
    pendingTools.clear();
    expandables.length = 0;
    synced = 0;
  };

  return {
    sync: (items) => {
      if (items.length < synced) {
        reset();
      }

      items.slice(synced).forEach(addItem);
      synced = items.length;
    },
    setToolsExpanded: (value) => {
      toolsExpanded = value;

      expandables.forEach((component) => {
        component.setExpanded(value);
      });
    },
    render: (width) => {
      const lines = container.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));

      rendered = lines.length;

      return lines;
    },
    click: (line, column, width) => {
      const result = container.handleMouse({
        type: "click",
        button: "left",
        x: column,
        y: line,
        screenX: column,
        screenY: line,
        width,
        height: rendered,
        shift: false,
        alt: false,
        ctrl: false,
        clickCount: 1,
      });

      return result?.handled === true;
    },
  };
};

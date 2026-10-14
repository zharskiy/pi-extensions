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
  type ExtensionContext,
  type ExtensionFactory,
  getMarkdownTheme,
  keyText,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import {
  type Component,
  Container,
  CURSOR_MARKER,
  Input,
  isKeyRelease,
  Key,
  type Keybinding,
  matchesKey,
  ScrollView,
  Spacer,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  AnyToolSpec,
  HostUi,
  InputPane,
  KeyPress,
  NotifyChannel,
  OverlayFactory,
  ScrollPane,
  TranscriptItem,
  TranscriptPane,
  WidgetHandle,
} from "./contract.ts";
import { themeLike } from "./pi-components.ts";
import { createEditorHooks, type EditorHooks } from "./pi-editor-frame.ts";
import { createEditorInput } from "./pi-editor-input.ts";
import { createFooterSetter } from "./pi-footer.ts";
import { keyPressWith } from "./pi-keys.ts";
import { toPiTool } from "./pi-tools.ts";
import { createWorkingUi } from "./pi-working.ts";

export { editorKeyPress } from "./pi-keys.ts";

const keyPress = (data: string, isToolsToggle: (data: string) => boolean): KeyPress =>
  keyPressWith(data, {
    isToolsToggle,
    isUp: (input) => matchesKey(input, Key.up),
    isDown: (input) => matchesKey(input, Key.down),
  });

const fitLines = (lines: string[], width: number) => lines.map((line) => truncateToWidth(line, width));

export type HostState = { ctx?: ExtensionContext };

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

/**
 * Runs each pi extension factory against a stub that only records `registerTool` and keeps the renderers of the
 * registered tool. A factory that throws or registers no renderer yields no entry, so the tool keeps pi's generic
 * display.
 */
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

export type TranscriptPaneOptions = { tools?: AnyToolSpec[]; piRenderers?: Record<string, ToolRenderers> };

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 133 prompt marks are ESC and BEL sequences
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export const createTranscriptPane = (
  tui: TUI,
  cwd: string,
  options: TranscriptPaneOptions = {},
): TranscriptPane => {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const definitions = new Map<string, object | undefined>();
  const expandables: Expandable[] = [];
  const renderers = options.piRenderers ?? defaultPiRenderers();
  let toolsExpanded = false;
  let synced = 0;
  let rendered = 0;

  const resolveDefinition = (name: string): object | undefined => {
    const builtin = toolDefinitionFactories[name];

    if (builtin) {
      return builtin(cwd);
    }

    const spec = options.tools?.find((tool) => tool.name === name);

    if (spec) {
      const { renderShell, renderCall, renderResult } = toPiTool(spec);

      return { renderShell, renderCall, renderResult };
    }

    return renderers[name];
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

      container.addChild(new AssistantMessageComponent(item.raw as never, true, getMarkdownTheme()));

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
      addExpandable(new CustomMessageComponent(item.raw as never, undefined, getMarkdownTheme()));
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

export const createScrollPane = (requestRender: () => void): ScrollPane => {
  let content: string[] = [];

  const view = new ScrollView({ render: () => content, invalidate: () => {} }, { follow: "end" });

  return {
    window: (lines, height) => {
      content = lines;
      view.updateLayout(lines.length, height, requestRender);

      return lines.slice(view.scrollTop, view.scrollTop + height);
    },
    scrollBy: (lines) => {
      view.scrollBy(lines);
    },
    scrollTo: (top, options) => {
      view.scrollTo(top, options);
    },
    scrollToStart: () => {
      view.scrollToStart();
    },
    scrollToEnd: () => {
      view.scrollToEnd();
    },
    state: () => ({
      top: view.scrollTop,
      height: view.viewportHeight,
      total: content.length,
      following: view.isFollowingEnd,
    }),
  };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fakeCursorMarkers = (): [string, string] => {
  const render = (tui as { renderFakeCursor?: (text: string) => string }).renderFakeCursor;
  const [start = "", end = ""] = render?.("\0").split("\0") ?? [];

  return [start, end];
};

export const createFakeCursorResolver = (
  start: string,
  end: string,
): ((lines: string[], hardwareCursor: boolean) => string[]) => {
  if (start === "" || end === "") {
    return (lines) => lines;
  }

  const focused = new RegExp(
    `(${escapeRegExp(CURSOR_MARKER)})${escapeRegExp(start)}(.*?)(?:${escapeRegExp(end)}|$)`,
    "s",
  );

  return (lines, hardwareCursor) =>
    lines.map((line) => {
      if (!line.includes(start)) {
        return line;
      }

      const resolved = hardwareCursor ? line.replace(focused, "$1$2") : line;

      return resolved.replaceAll(start, "\x1b[7m").replaceAll(end, "\x1b[27m");
    });
};

export const resolveFakeCursors = createFakeCursorResolver(...fakeCursorMarkers());

export const createInputPane = (
  placeholder: string,
  hardwareCursor: () => boolean = () => false,
): InputPane => {
  const input = new Input({ placeholder });
  let outcome: "submitted" | "cancelled" | undefined;

  input.focused = true;
  input.onSubmit = () => {
    outcome = "submitted";
  };
  input.onEscape = () => {
    outcome = "cancelled";
  };

  return {
    feed: (key) => {
      outcome = undefined;
      input.handleInput(key.raw ?? key.char ?? "");

      return outcome ?? "changed";
    },
    value: () => input.getValue(),
    setValue: (value) => {
      input.setValue(value);
    },
    setFocused: (focused) => {
      input.focused = focused;
    },
    render: (width) => resolveFakeCursors(input.render(width), hardwareCursor()),
  };
};

type TerminalOut = { write(data: string): unknown };

const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+`,
  "g",
);

const cleanText = (text: string) => text.replace(CONTROL_CHARS, " ").trim();

type TerminalEnv = { TERM?: string; TERM_PROGRAM?: string };

const OSC_777_TERMINALS = /rxvt/i;

const usesOsc777 = (env: TerminalEnv) =>
  [env.TERM, env.TERM_PROGRAM].some((name) => OSC_777_TERMINALS.test(name ?? ""));

const OSC_777_TITLE = "pi";

export const notificationSequence = (
  message: string,
  channel: NotifyChannel,
  env: TerminalEnv = process.env,
) => {
  const text = cleanText(message);

  if (channel === "bell") {
    return "\x07";
  }

  if (usesOsc777(env)) {
    return `\x1b]777;notify;${OSC_777_TITLE};${text}\x07`;
  }

  return `\x1b]9;${text}\x07`;
};

export const tuiContext = (state: HostState) => (state.ctx?.mode === "tui" ? state.ctx : undefined);

export const createUi = (
  state: HostState,
  stdout: TerminalOut = process.stdout,
  env: TerminalEnv = process.env,
  editor: EditorHooks = createEditorHooks(() => tuiContext(state)),
): HostUi => {
  const widgetTuis = new Map<string, TUI>();
  let lastTui: TUI | undefined;

  const tuiCtx = () => tuiContext(state);

  const setWidget: HostUi["setWidget"] = (key, render) => {
    const ctx = tuiCtx();
    const handle: WidgetHandle = { refresh: () => widgetTuis.get(key)?.requestRender() };

    if (!ctx) {
      return handle;
    }

    if (!render) {
      widgetTuis.delete(key);
      ctx.ui.setWidget(key, undefined);
      return handle;
    }

    ctx.ui.setWidget(
      key,
      (tui, theme) => {
        const widgetTheme = themeLike(theme);

        widgetTuis.set(key, tui);

        lastTui = tui;

        return {
          render: (width: number) => fitLines(render(width, widgetTheme), width),
          invalidate: () => {},
        };
      },
      { placement: "belowEditor" },
    );

    return handle;
  };

  const openOverlay = async (factory: OverlayFactory) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return;
    }

    const cwd = ctx.cwd;

    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        lastTui = tui;

        const view = factory({
          theme: themeLike(theme),
          rows: () => tui.terminal.rows,
          close: () => done(),
          requestRender: () => tui.requestRender(),
          toolsKey: keyText("app.tools.expand"),
          wheelScrolling: tui.mode === "fullscreen",
          createTranscript: (options) => createTranscriptPane(tui, cwd, { tools: options?.tools }),
          createScroll: () => createScrollPane(() => tui.requestRender()),
          createInput: (placeholder) => createInputPane(placeholder, () => tui.getShowHardwareCursor()),
        });

        const isToolsToggle = (data: string) => keybindings.matches(data, "app.tools.expand");

        return {
          render: (width: number) => fitLines(view.render(width), width),
          handleInput: (data: string) => {
            view.handleKey(keyPress(data, isToolsToggle));
            tui.requestRender();
          },
          handleMouse: (event: TuiMouseEvent) => {
            if (event.type === "click" && event.button === "left") {
              return view.handleClick?.(event.x, event.y) ? { handled: true } : undefined;
            }

            if (event.type !== "wheel" || !view.handleWheel) {
              return undefined;
            }

            view.handleWheel(event.wheelDelta ?? 0);

            return { handled: true };
          },
          invalidate: () => {},
          dispose: () => view.dispose?.(),
        };
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
    );
  };

  return {
    notify: (message, level) => {
      state.ctx?.ui.notify(message, level);
    },
    setStatus: (key, text) => {
      state.ctx?.ui.setStatus(key, text);
    },
    confirm: async (title, message) => {
      const ctx = state.ctx;

      if (!ctx?.hasUI) {
        return false;
      }

      return ctx.ui.confirm(title, message);
    },
    input: async (title, placeholder) => {
      const ctx = state.ctx;

      if (!ctx?.hasUI) {
        return undefined;
      }

      return ctx.ui.input(title, placeholder);
    },
    setWidget,
    openOverlay,
    select: async (title, options) => {
      const ctx = state.ctx;

      if (!ctx?.hasUI) {
        return undefined;
      }

      return ctx.ui.select(title, options);
    },
    style: (token, text) => state.ctx?.ui.theme.fg(token, text) ?? text,
    terminalNotify: (message, channel) => {
      if (!tuiCtx()) {
        return;
      }

      const sequence = notificationSequence(message, channel, env);

      if (lastTui) {
        lastTui.terminal.write(sequence);
        return;
      }

      stdout.write(sequence);
    },
    ...createWorkingUi(tuiCtx),
    ...createEditorInput(tuiCtx),
    setEditorFrame: editor.setEditorFrame,
    onEmptyEditorLeft: editor.onEmptyEditorLeft,
    captureEditorKeys: editor.captureEditorKeys,
    setFooter: createFooterSetter(tuiCtx, themeLike),
    keyText: (binding) => keyText(binding as Keybinding),
    onKeyPress: (listener) =>
      tuiCtx()?.ui.onTerminalInput((data) => {
        if (!isKeyRelease(data) && !data.startsWith("\x1b[<") && !data.startsWith("\x1b[M")) {
          listener();
        }

        return undefined;
      }) ?? (() => {}),
  };
};

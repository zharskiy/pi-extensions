import {
  AssistantMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionContext,
  getMarkdownTheme,
  initTheme,
  keyText,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  Key,
  matchesKey,
  ScrollView,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  HostUi,
  InputPane,
  KeyPress,
  OverlayFactory,
  ScrollPane,
  ThemeLike,
  TranscriptItem,
  TranscriptPane,
  WidgetHandle,
} from "./contract.ts";

export const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(token, text),
  bold: (text) => theme.bold(text),
});

const keyPress = (data: string, isToolsToggle: (data: string) => boolean): KeyPress => {
  if (isToolsToggle(data)) {
    return { name: "toggleTools", raw: data };
  }

  const names = [
    ["up", Key.up],
    ["down", Key.down],
    ["pageUp", Key.pageUp],
    ["pageDown", Key.pageDown],
    ["home", Key.home],
    ["end", Key.end],
    ["enter", Key.enter],
    ["escape", Key.escape],
    ["space", Key.space],
    ["tab", Key.tab],
  ] as const;

  const match = names.find(([, key]) => matchesKey(data, key));

  if (match) {
    return { name: match[0], raw: data };
  }

  return { name: "other", char: data.length === 1 ? data : undefined, raw: data };
};

export const textComponent = (previous: unknown, text: string): Component => {
  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }

  return new Text(text, 0, 0);
};

const fitLines = (lines: string[], width: number) => lines.map((line) => truncateToWidth(line, width));

export type HostState = {
  ctx?: ExtensionContext;
  stale: boolean;
};

export const liveCtx = (state: HostState) => {
  if (state.stale || !state.ctx) {
    return undefined;
  }

  return state.ctx;
};

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

type RawToolCall = { type: string; id?: string; name?: string; arguments?: unknown };

type RawAssistant = { content?: RawToolCall[]; stopReason?: string; errorMessage?: string };

type Expandable = Component & { setExpanded(expanded: boolean): void };

export const initRenderTheme = () => {
  initTheme(undefined, false);
};

export const createTranscriptPane = (tui: TUI, cwd: string, expanded: boolean): TranscriptPane => {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const definitions = new Map<string, object | undefined>();
  const expandables: Expandable[] = [];
  let toolsExpanded = expanded;
  let synced = 0;

  const definitionFor = (name: string) => {
    if (!definitions.has(name)) {
      definitions.set(name, toolDefinitionFactories[name]?.(cwd));
    }

    return definitions.get(name);
  };

  const addExpandable = (component: Expandable) => {
    component.setExpanded(toolsExpanded);
    expandables.push(component);
    container.addChild(component);
  };

  const addToolCall = (call: RawToolCall, message: RawAssistant) => {
    const id = call.id ?? "";
    const name = call.name ?? "tool";
    const component = new ToolExecutionComponent(
      name,
      id,
      call.arguments ?? {},
      {},
      definitionFor(name) as never,
      tui,
      cwd,
    );

    addExpandable(component);

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";

      component.updateResult({ content: [{ type: "text", text }], isError: true });
      return;
    }

    pendingTools.set(id, component);
  };

  const addItem = (item: TranscriptItem) => {
    if (item.kind === "user") {
      container.addChild(new UserMessageComponent(item.text, getMarkdownTheme()));
      return;
    }

    if (item.kind === "assistant") {
      const message = item.raw as RawAssistant;

      container.addChild(new AssistantMessageComponent(item.raw as never, true, getMarkdownTheme()));

      (message.content ?? [])
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
    render: (width) => container.render(width),
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
    scrollTo: (top) => {
      view.scrollTo(top);
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

export const createInputPane = (placeholder: string): InputPane => {
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
    render: (width) => input.render(width),
  };
};

export const createUi = (state: HostState): HostUi => {
  const widgetTuis = new Map<string, TUI>();

  const tuiCtx = () => {
    const ctx = liveCtx(state);

    if (ctx?.mode !== "tui") {
      return undefined;
    }

    return ctx;
  };

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
    const toolsExpanded = ctx.ui.getToolsExpanded();

    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        const view = factory({
          theme: themeLike(theme),
          rows: () => tui.terminal.rows,
          close: () => done(),
          requestRender: () => tui.requestRender(),
          toolsExpanded,
          toolsKey: keyText("app.tools.expand"),
          wheelScrolling: tui.mode === "fullscreen",
          createTranscript: () => createTranscriptPane(tui, cwd, toolsExpanded),
          createScroll: () => createScrollPane(() => tui.requestRender()),
          createInput: createInputPane,
        });

        const isToolsToggle = (data: string) => keybindings.matches(data, "app.tools.expand");

        return {
          render: (width: number) => fitLines(view.render(width), width),
          handleInput: (data: string) => {
            view.handleKey(keyPress(data, isToolsToggle));
            tui.requestRender();
          },
          handleMouse: (event: TuiMouseEvent) => {
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
    notify: (message, level = "info") => {
      liveCtx(state)?.ui.notify(message, level);
    },
    setStatus: (key, text) => {
      liveCtx(state)?.ui.setStatus(key, text);
    },
    confirm: async (title, message) => {
      const ctx = liveCtx(state);

      if (!ctx?.hasUI) {
        return false;
      }

      return ctx.ui.confirm(title, message);
    },
    input: async (title, placeholder) => {
      const ctx = liveCtx(state);

      if (!ctx?.hasUI) {
        return undefined;
      }

      return ctx.ui.input(title, placeholder);
    },
    setWidget,
    openOverlay,
    select: async (title, options) => {
      const ctx = liveCtx(state);

      if (!ctx?.hasUI) {
        return undefined;
      }

      return ctx.ui.select(title, options);
    },
    style: (token, text) => liveCtx(state)?.ui.theme.fg(token, text) ?? text,
  };
};

import { type ExtensionContext, keyText } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  type Keybinding,
  ScrollView,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  AnyToolSpec,
  HostUi,
  NotifyChannel,
  OverlayFactory,
  ScrollPane,
  WidgetHandle,
} from "./contract.ts";
import type { EditorHooks } from "./pi-editor.ts";
import { captureTui, createEditorInput } from "./pi-editor-input.ts";
import { createFooterSetter } from "./pi-footer.ts";
import { createShowForm } from "./pi-form.ts";
import { keyPress } from "./pi-keys.ts";
import { themeLike } from "./pi-tools.ts";
import { createTranscriptPane } from "./pi-transcript.ts";
import { createWorkingUi } from "./pi-working.ts";

const fitLines = (lines: string[], width: number) => lines.map((line) => truncateToWidth(line, width, "…"));

export type HostState = { ctx?: ExtensionContext; tools: Map<string, AnyToolSpec> };

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

export const notificationSequence = (message: string, channel: NotifyChannel, env: TerminalEnv) => {
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
  stdout: TerminalOut,
  env: TerminalEnv,
  editor: EditorHooks,
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
          createTranscript: (options) =>
            createTranscriptPane(tui, cwd, { tools: [...state.tools.values()], owner: options?.owner }),
          createScroll: () => createScrollPane(() => tui.requestRender()),
        });

        return {
          render: (width: number) => fitLines(view.render(width), width),
          handleInput: (data: string) => {
            view.handleKey(keyPress(data, keybindings));
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
    setWidget,
    openOverlay,
    showForm: createShowForm(tuiCtx, (ctx) => lastTui ?? captureTui(ctx)),
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
    onEmptyEditorDown: editor.onEmptyEditorDown,
    captureEditorKeys: editor.captureEditorKeys,
    setFooter: createFooterSetter(tuiCtx),
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

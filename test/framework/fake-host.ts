import {
  type CommandSpec,
  type ContextFacts,
  type ContextSnapshot,
  type DialogEvent,
  type DialogKind,
  type EditorFrame,
  type EditorKeyHandler,
  type EntryRender,
  emptyUsage,
  type FooterRender,
  type HiddenMessage,
  type Host,
  type IdleInfo,
  type KeyPress,
  type MessageRender,
  type ModelInfo,
  type NewSessionOptions,
  type NotifyChannel,
  type OverlayFactory,
  type Phase,
  type PromptTokens,
  type RowLines,
  type SessionControl,
  type SessionInfo,
  type ShutdownReason,
  type ThemeLike,
  type ToolRender,
  type ToolRenderState,
  type ToolResult,
  type ToolRows,
  type ToolSpec,
  type UsageTotals,
} from "../../platform/pi-adapter/index.ts";
import { type FakeForm, openFakeForm } from "./fake-form.ts";
import { plainTheme } from "./themes.ts";
import { promptTokens } from "./usage-builders.ts";

type FakeSessionFile = { entries: { customType: string; data: unknown }[]; usage: UsageTotals };

export type FakeHost = Host & {
  tools: Map<string, ToolSpec<never, never>>;
  commands: Map<string, CommandSpec>;
  mainPrompt?: string;
  promptSections: Map<string, string>;
  entries: { customType: string; data: unknown }[];
  files: Map<string, FakeSessionFile>;
  hidden: { message: HiddenMessage; delivery: "followUp" | "run" }[];
  dispatched: string[];
  published: { channel: string; data: unknown }[];
  notices: { message: string; level?: string }[];
  terminalNotices: { message: string; channel: NotifyChannel }[];
  statuses: Map<string, string | undefined>;
  editorNotices: Map<string, string | undefined>;
  statusCalls: { key: string; text: string | undefined }[];
  widgets: Map<string, RowLines | undefined>;
  belowEditor: string[];
  widgetRefreshes: number;
  overlays: OverlayFactory[];
  forms: FakeForm[];
  form(): FakeForm;
  editorFrame?: EditorFrame;
  foreignEditor: boolean;
  emptyLeftHandlers: Set<() => void>;
  editorCapture?: EditorKeyHandler;
  pressEmptyLeft(): boolean;
  pressEmptyDown(): boolean;
  pressEmptyEscape(): boolean;
  pressEditorKey(key: KeyPress): "consumed" | "release" | "editor";
  idle: boolean;
  usage: UsageTotals;
  info: SessionInfo;
  confirmations: { title: string; message: string }[];
  confirmAnswer: boolean | ((title: string, message: string) => boolean);
  newSessions: NewSessionOptions[];
  newSessionResult: boolean | Error;
  start(parent?: string): void;
  turnEnd(context: { tokens: number | null; window: number; percent?: number | null }): void;
  compact(): void;
  settle(options?: { aborted?: boolean }): void;
  emit(channel: string, data: unknown): void;
  runCommand(name: string, args?: string): Promise<void>;
  shutdown(reason?: ShutdownReason): Promise<void>;
  tool<P, D>(name: string): ToolSpec<P, D>;
  renderTool(
    name: string,
    input: {
      call?: unknown;
      result?: ToolResult<unknown>;
      state?: Partial<ToolRenderState>;
      width?: number;
    },
  ): { call?: string; result?: string; state: ToolRenderState };
  workingMessages: (string | undefined)[];
  workingVisibility: boolean[];
  agentStart(): void;
  setPhase(phase: Phase): void;
  submitRewrites: ((text: string) => string | undefined)[];
  completionMaps: ((command: string) => string | undefined)[];
  editorSubmissions: string[];
  editorReachable: boolean;
  footer?: FooterRender;
  footerRefreshes: number;
  contextUsage: ContextSnapshot;
  activeModel?: ModelInfo;
  thinking: string;
  sessionTitle?: string;
  keyListeners: Set<() => void>;
  pressKey(): void;
  toolRows?: ToolRows;
  thinkingLabels: { label: string | undefined; hint?: string }[];
  renderMessage(
    customType: string,
    message: { text: string; details?: unknown },
    options?: { width?: number; expanded?: boolean; theme?: ThemeLike },
  ): string[];
  renderEntry(
    customType: string,
    data: unknown,
    options?: { width?: number; expanded?: boolean; theme?: ThemeLike },
  ): string[];
  facts?: ContextFacts;
  lastUsage?: PromptTokens;
  mainUsage: PromptTokens;
  dialog(phase: DialogEvent["phase"], kind: DialogKind, title?: string): void;
};

export const FAKE_FOOTER_KEY = "footer";

export const createFakeHost = (info: Partial<SessionInfo> = {}): FakeHost => {
  const startHandlers: ((info: SessionInfo, parent?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: ((info: IdleInfo) => void)[] = [];
  const turnHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const agentStartHandlers: (() => void)[] = [];
  const phaseHandlers: ((phase: Phase) => void)[] = [];
  const dialogHandlers: ((event: DialogEvent) => void)[] = [];
  const emptyDownHandlers = new Set<() => void>();
  const emptyEscapeHandlers = new Set<() => boolean>();
  const entryRenderers = new Map<string, EntryRender>();
  const messageRenderers = new Map<string, MessageRender>();
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const deferred: { name: string; args?: string }[] = [];
  let started = false;
  const editorLive = () => started && !host.foreignEditor;

  const pressEmpty = (registered: Set<() => void>) => {
    if (!editorLive()) {
      return false;
    }

    const handlers = Array.from(registered);

    handlers.forEach((handler) => {
      handler();
    });

    return handlers.length > 0;
  };
  let stale = false;
  let settling = false;
  let currentPhase: Phase = "idle";

  const control: SessionControl = {
    newSession: async (options) => {
      host.newSessions.push(options);

      if (host.newSessionResult instanceof Error) {
        throw host.newSessionResult;
      }

      return host.newSessionResult;
    },
  };

  const deliver = (channel: string, data: unknown) => {
    Array.from(channels.get(channel) ?? []).forEach((handler) => {
      handler(data);
    });
  };

  const sessionFile = (file: string | undefined): FakeSessionFile =>
    file ? (host.files.get(file) as FakeSessionFile) : host;

  const host: FakeHost = {
    tools: new Map(),
    commands: new Map(),
    promptSections: new Map(),
    entries: [],
    files: new Map(),
    hidden: [],
    dispatched: [],
    published: [],
    notices: [],
    terminalNotices: [],
    statuses: new Map(),
    editorNotices: new Map(),
    statusCalls: [],
    widgets: new Map(),
    belowEditor: [],
    widgetRefreshes: 0,
    overlays: [],
    forms: [],
    form: () => {
      const open = host.forms.at(-1);

      if (!open) {
        throw new Error("no form shown");
      }

      return open;
    },
    foreignEditor: false,
    emptyLeftHandlers: new Set(),
    pressEmptyLeft: () => pressEmpty(host.emptyLeftHandlers),
    pressEmptyDown: () => pressEmpty(emptyDownHandlers),
    pressEmptyEscape: () =>
      editorLive() && host.idle && Array.from(emptyEscapeHandlers).some((handler) => handler()),
    pressEditorKey: (key) => {
      if (!editorLive()) {
        return "editor";
      }

      const capture = host.editorCapture;
      const outcome = capture ? capture(key) : "editor";

      if (outcome === "release" && host.editorCapture === capture) {
        host.editorCapture = undefined;
      }

      if (outcome !== "consumed" && key.name === "left") {
        host.pressEmptyLeft();
      }

      if (outcome !== "consumed" && key.name === "down") {
        host.pressEmptyDown();
      }

      return outcome;
    },
    idle: true,
    usage: emptyUsage(),
    confirmations: [],
    confirmAnswer: true,
    newSessions: [],
    newSessionResult: true,
    submitRewrites: [],
    completionMaps: [],
    editorSubmissions: [],
    editorReachable: true,
    info: {
      id: "main-session",
      file: undefined,
      cwd: "/tmp/pi-extensions-test",
      agentDir: "/tmp/pi-extensions-test/agent",
      projectTrusted: false,
      subscription: false,
      mode: "tui",
      ...info,
    },
    ui: {
      notify: (message, level) => {
        host.notices.push({ message, level });
      },
      setStatus: (key, text) => {
        host.statusCalls.push({ key, text });
        host.statuses.set(key, text);
      },
      setNotice: (key, text) => {
        host.editorNotices.set(key, text);
      },
      confirm: async (title, message) => {
        host.confirmations.push({ title, message });

        return typeof host.confirmAnswer === "function"
          ? host.confirmAnswer(title, message)
          : host.confirmAnswer;
      },
      setWidget: (key, render) => {
        host.widgets.set(key, render);
        host.belowEditor = host.belowEditor.filter((entry) => entry !== key);

        if (render) {
          host.belowEditor.push(key);
        }
        return {
          refresh: () => {
            host.widgetRefreshes += 1;
          },
        };
      },
      openOverlay: async (factory) => {
        host.overlays.push(factory);
      },
      showForm: async (factory, options = {}) => {
        if (!started || host.info.mode !== "tui" || options.signal?.aborted) {
          return undefined;
        }

        return openFakeForm(factory, plainTheme, options.signal, (form) => {
          host.forms.push(form);
        });
      },
      style: (token, text) => `<${token}>${text}`,
      terminalNotify: (message, channel) => {
        host.terminalNotices.push({ message, channel });
      },
      setWorkingMessage: (text) => {
        host.workingMessages.push(text);
      },
      setWorkingVisible: (visible) => {
        host.workingVisibility.push(visible);
      },
      onEditorSubmit: (rewrite) => {
        host.submitRewrites.push(rewrite);

        return () => {
          host.submitRewrites = host.submitRewrites.filter((entry) => entry !== rewrite);
        };
      },
      mapCommandCompletion: (map) => {
        host.completionMaps.push(map);
      },
      submitEditor: async (text) => {
        host.editorSubmissions.push(text);

        return host.editorReachable;
      },
      setEditorFrame: (frame) => {
        if (host.foreignEditor) {
          return;
        }

        host.editorFrame = frame;
      },
      onEmptyEditorLeft: (handler) => {
        const entry = () => handler();

        host.emptyLeftHandlers.add(entry);

        return () => {
          host.emptyLeftHandlers.delete(entry);
        };
      },
      onEmptyEditorDown: (handler) => {
        const entry = () => handler();

        emptyDownHandlers.add(entry);

        return () => {
          emptyDownHandlers.delete(entry);
        };
      },
      onEmptyEditorEscape: (handler) => {
        const entry = () => handler();

        emptyEscapeHandlers.add(entry);

        return () => {
          emptyEscapeHandlers.delete(entry);
        };
      },
      captureEditorKeys: (handler) => {
        host.editorCapture = handler;

        return () => {
          if (host.editorCapture === handler) {
            host.editorCapture = undefined;
          }
        };
      },
      setFooter: (render) => {
        host.footer = render;

        if (!render) {
          host.belowEditor = host.belowEditor.filter((entry) => entry !== FAKE_FOOTER_KEY);
        } else if (!host.belowEditor.includes(FAKE_FOOTER_KEY)) {
          host.belowEditor.push(FAKE_FOOTER_KEY);
        }

        return {
          refresh: () => {
            host.footerRefreshes += 1;
          },
        };
      },
      keyText: (binding) => `<${binding}>`,
      onKeyPress: (listener) => {
        const entry = () => listener();

        host.keyListeners.add(entry);

        return () => {
          host.keyListeners.delete(entry);
        };
      },
      setHiddenThinkingLabel: (label, hint) => {
        host.thinkingLabels.push(hint === undefined ? { label } : { label, hint });
      },
    },
    registerTool: (spec) => {
      host.tools.set(spec.name, spec as unknown as ToolSpec<never, never>);
    },
    registerCommand: (name, spec) => {
      host.commands.set(name, spec);
    },
    setMainPrompt: (text) => {
      host.mainPrompt = text;
    },
    setPromptSection: (name, text) => {
      if (text === undefined) {
        host.promptSections.delete(name);
        return;
      }

      host.promptSections.set(name, text);
    },
    onSessionStart: (handler) => {
      startHandlers.push(handler);
    },
    onSessionShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
    onIdle: (handler) => {
      idleHandlers.push(handler);
    },
    onTurnEnd: (handler) => {
      turnHandlers.push(handler);
    },
    onCompact: (handler) => {
      compactHandlers.push(handler);
    },
    isIdle: () => started && host.idle,
    sendHiddenMessage: (message) => {
      if (!started) {
        return;
      }

      host.hidden.push({ message: structuredClone(message), delivery: host.idle ? "run" : "followUp" });
    },
    dispatchCommand: (name, args) => {
      host.dispatched.push(args ? `${name} ${args}` : name);

      if (settling) {
        deferred.push({ name, args });
        return;
      }

      void host.runCommand(name, args);
    },
    publish: (channel, data) => {
      if (stale) {
        return;
      }

      host.published.push({ channel, data: structuredClone(data) });
      deliver(channel, data);
    },
    subscribe: (channel, handler) => {
      const set = channels.get(channel) ?? new Set();

      set.add(handler);
      channels.set(channel, set);

      return () => {
        set.delete(handler);
      };
    },
    appendEntry: (customType, data) => {
      if (stale) {
        return;
      }

      host.entries.push({ customType, data: structuredClone(data) });
    },
    readEntries: <T>(customType: string, file?: string) =>
      sessionFile(file)
        .entries.filter((entry) => entry.customType === customType)
        .map((entry) => entry.data as T),
    sessionUsage: (file) => sessionFile(file).usage,
    session: () => {
      if (!started) {
        throw new Error("no live pi session: called before session_start or after session_shutdown");
      }

      return host.info;
    },
    start: (parent) => {
      started = true;
      stale = false;

      startHandlers.forEach((handler) => {
        handler(host.info, parent);
      });
    },
    turnEnd: (turn) => {
      const context = { tokens: turn.tokens, window: turn.window, percent: turn.percent ?? null };

      host.idle = false;

      turnHandlers.forEach((handler) => {
        handler(context);
      });
    },
    compact: () => {
      compactHandlers.forEach((handler) => {
        handler();
      });
    },
    settle: (options) => {
      host.idle = true;
      settling = true;
      const idleInfo: IdleInfo = { aborted: options?.aborted ?? false };

      idleHandlers.forEach((handler) => {
        handler(idleInfo);
      });

      settling = false;
      host.setPhase("idle");

      deferred.splice(0).forEach(({ name, args }) => {
        void host.runCommand(name, args);
      });
    },
    emit: deliver,
    runCommand: async (name, args = "") => {
      const spec = host.commands.get(name);

      if (!spec) {
        throw new Error(`command ${name} not registered`);
      }

      await spec.run(args, control);
    },
    shutdown: async (reason = "quit") => {
      currentPhase = "idle";

      await shutdownHandlers.reduce<Promise<void>>(
        (chain, handler) => chain.then(() => handler(reason)),
        Promise.resolve(),
      );

      started = false;
      stale = true;
    },
    tool: <P, D>(name: string) => {
      const spec = host.tools.get(name);

      if (!spec) {
        throw new Error(`tool ${name} not registered`);
      }

      return spec as unknown as ToolSpec<P, D>;
    },
    renderTool: (name, { call, result, state: overrides, width = 80 }) => {
      const spec = host.tool<unknown, unknown>(name);
      const state: ToolRenderState = {
        expanded: false,
        isPartial: false,
        isError: result?.isError ?? false,
        args: call,
        aborted: false,
        ...(result ? { result } : {}),
        invalidate: () => {},
        ...overrides,
      };

      const inner = Math.max(1, width - (spec.renderShell === "row" ? 1 : 0));
      const resolve = (render: ToolRender | undefined) =>
        typeof render === "function" ? render(inner) : render;

      return {
        call: call === undefined ? undefined : resolve(spec.renderCall?.(call, plainTheme, state)),
        result: result === undefined ? undefined : resolve(spec.renderResult?.(result, state, plainTheme)),
        state,
      };
    },
    workingMessages: [],
    workingVisibility: [],
    onAgentStart: (handler) => {
      agentStartHandlers.push(handler);
    },
    agentStart: () => {
      host.idle = false;

      agentStartHandlers.forEach((handler) => {
        handler();
      });

      host.setPhase("waiting");
    },
    onPhase: (handler) => {
      phaseHandlers.push(handler);
    },
    setPhase: (phase) => {
      if (currentPhase === phase) {
        return;
      }

      currentPhase = phase;

      phaseHandlers.forEach((handler) => {
        handler(phase);
      });
    },
    footerRefreshes: 0,
    contextUsage: { tokens: null, window: 0, percent: null },
    thinking: "off",
    context: () => host.contextUsage,
    model: () => host.activeModel,
    thinkingLevel: () => host.thinking,
    sessionName: () => host.sessionTitle,
    registerEntryRenderer: (customType, render) => {
      entryRenderers.set(customType, render);
    },
    registerToolRows: (rows) => {
      host.toolRows = rows;
    },
    thinkingLabels: [],
    registerMessageRenderer: (customType, render) => {
      messageRenderers.set(customType, render);
    },
    renderMessage: (customType, message, { width = 80, expanded = false, theme = plainTheme } = {}) => {
      const render = messageRenderers.get(customType);

      if (!render) {
        throw new Error(`message renderer ${customType} not registered`);
      }

      return render(structuredClone(message), width, expanded, theme).map((line) =>
        theme.truncate(line, width),
      );
    },
    renderEntry: (customType, data, { width = 80, expanded = false, theme = plainTheme } = {}) => {
      const render = entryRenderers.get(customType);

      if (!render) {
        throw new Error(`entry renderer ${customType} not registered`);
      }

      return render(structuredClone(data), width, expanded, theme).map((line) => theme.truncate(line, width));
    },
    mainUsage: promptTokens(),
    contextFacts: () => (host.facts ? structuredClone(host.facts) : undefined),
    lastRequestUsage: () => host.lastUsage,
    mainRequestUsage: () => host.mainUsage,
    keyListeners: new Set(),
    pressKey: () => {
      Array.from(host.keyListeners).forEach((listener) => {
        listener();
      });
    },
    onDialog: (handler) => {
      dialogHandlers.push(handler);
    },
    dialog: (phase, kind, title) => {
      dialogHandlers.forEach((handler) => {
        handler({ phase, kind, title });
      });
    },
  };

  return host;
};

export const hiddenMessageTexts = (host: Pick<FakeHost, "hidden">) =>
  host.hidden.map((entry) => entry.message.text);

export const createTurnScope = (host: Pick<FakeHost, "idle" | "settle">) => {
  const state = { open: 0 };

  return async <T>(work: () => Promise<T>): Promise<T> => {
    state.open += 1;
    host.idle = false;

    try {
      return await work();
    } finally {
      state.open -= 1;

      if (state.open === 0) {
        host.settle();
      }
    }
  };
};

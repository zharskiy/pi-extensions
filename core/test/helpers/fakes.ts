import {
  type AgentRuntime,
  type ChildEvent,
  type ChildSession,
  type CommandSpec,
  type ContextSnapshot,
  type DialogEvent,
  type DialogKind,
  type EditorFrame,
  type EditorKeyHandler,
  emptyUsage,
  type FooterRender,
  type HiddenMessage,
  type Host,
  type KeyPress,
  type MessageDelivery,
  type ModelInfo,
  type NewSessionOptions,
  type NotifyChannel,
  type OverlayFactory,
  type Phase,
  type PhaseDetail,
  type RoutedMessage,
  type SessionControl,
  type SessionInfo,
  type SessionRecord,
  type ShutdownReason,
  type SpawnSpec,
  type StopReason,
  type ThemeLike,
  type ToolRender,
  type ToolRenderState,
  type ToolResult,
  type ToolSpec,
  type ToolTone,
  type UsageTotals,
  type WorkingIndicator,
} from "../../adapter/contract.ts";
import { type CatalogModel, type ModelPreferences, resolveModel } from "../../adapter/model-resolver.ts";

export const plainTheme: ThemeLike = { fg: (_token, text) => text, bold: (text) => text };

type FakeSessionFile = { entries: { customType: string; data: unknown }[]; usage: UsageTotals };

export type FakeHost = Host & {
  tools: Map<string, ToolSpec<never, never>>;
  commands: Map<string, CommandSpec>;
  mainPrompt?: string;
  entries: { customType: string; data: unknown }[];
  files: Map<string, FakeSessionFile>;
  sent: string[];
  hidden: { message: HiddenMessage; delivery: "followUp" | "run" }[];
  dispatched: string[];
  published: { channel: string; data: unknown }[];
  notices: { message: string; level?: string }[];
  terminalNotices: { message: string; channel: NotifyChannel }[];
  statuses: Map<string, string | undefined>;
  widgets: Map<string, ((width: number, theme: ThemeLike) => string[]) | undefined>;
  belowEditor: string[];
  widgetRefreshes: number;
  overlays: OverlayFactory[];
  editorFrame?: EditorFrame;
  foreignEditor: boolean;
  emptyLeftHandlers: Set<() => void>;
  emptyDownHandlers: Set<() => void>;
  editorCapture?: EditorKeyHandler;
  pressEmptyLeft(): boolean;
  pressEmptyDown(): boolean;
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
  settle(): void;
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
  ): { call?: string; result?: string; state: ToolRenderState; tone?: ToolTone };
  workingIndicators: (WorkingIndicator | undefined)[];
  workingMessages: (string | undefined)[];
  workingVisibility: boolean[];
  agentStart(): void;
  phases: { phase: Phase; detail: PhaseDetail }[];
  setPhase(phase: Phase, detail?: PhaseDetail): void;
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
  dialog(phase: DialogEvent["phase"], kind: DialogKind, title?: string): void;
};

export const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

export const FAKE_FOOTER_KEY = "footer";

export const createFakeHost = (info: Partial<SessionInfo> = {}): FakeHost => {
  const startHandlers: ((info: SessionInfo, parent?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  const turnHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const agentStartHandlers: (() => void)[] = [];
  const phaseHandlers: ((phase: Phase, detail: PhaseDetail) => void)[] = [];
  const dialogHandlers: ((event: DialogEvent) => void)[] = [];
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
  let currentPhase: { phase: Phase; detail: PhaseDetail } = { phase: "idle", detail: { running: 0 } };

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
    entries: [],
    files: new Map(),
    sent: [],
    hidden: [],
    dispatched: [],
    published: [],
    notices: [],
    terminalNotices: [],
    statuses: new Map(),
    widgets: new Map(),
    belowEditor: [],
    widgetRefreshes: 0,
    overlays: [],
    foreignEditor: false,
    emptyLeftHandlers: new Set(),
    emptyDownHandlers: new Set(),
    pressEmptyLeft: () => pressEmpty(host.emptyLeftHandlers),
    pressEmptyDown: () => pressEmpty(host.emptyDownHandlers),
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
        host.statuses.set(key, text);
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
      style: (token, text) => `<${token}>${text}`,
      terminalNotify: (message, channel) => {
        host.terminalNotices.push({ message, channel });
      },
      setWorkingIndicator: (indicator) => {
        host.workingIndicators.push(indicator);
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

        host.emptyDownHandlers.add(entry);

        return () => {
          host.emptyDownHandlers.delete(entry);
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
    sendUserMessage: (text) => {
      if (stale) {
        return;
      }

      host.sent.push(text);
    },
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
    settle: () => {
      host.idle = true;
      settling = true;

      idleHandlers.forEach((handler) => {
        handler();
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
      currentPhase = { phase: "idle", detail: { running: 0 } };

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
        toolCallId: "call-1",
        expanded: false,
        isPartial: false,
        isError: result?.isError ?? false,
        args: call,
        outputPad: 1,
        invalidate: () => {},
        ...overrides,
      };

      const shelled = spec.renderShell === "box";
      const inner = shelled ? Math.max(1, width - 2 * state.outputPad) : width;
      const piTone: ToolTone = state.isPartial ? "pending" : state.isError ? "error" : "success";
      const resolve = (render: ToolRender | undefined) =>
        typeof render === "function" ? render(inner) : render;

      return {
        call: call === undefined ? undefined : resolve(spec.renderCall?.(call, plainTheme, state)),
        result: result === undefined ? undefined : resolve(spec.renderResult?.(result, state, plainTheme)),
        state,
        ...(spec.renderShell === "box" ? { tone: spec.renderTone?.(state, result) ?? piTone } : {}),
      };
    },
    workingIndicators: [],
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
    phases: [],
    onPhase: (handler) => {
      phaseHandlers.push(handler);
    },
    setPhase: (phase, detail = { running: 0 }) => {
      if (
        currentPhase.phase === phase &&
        currentPhase.detail.toolName === detail.toolName &&
        currentPhase.detail.running === detail.running
      ) {
        return;
      }

      currentPhase = { phase, detail };
      host.phases.push({ phase, detail });

      phaseHandlers.forEach((handler) => {
        handler(phase, detail);
      });
    },
    footerRefreshes: 0,
    contextUsage: { tokens: null, window: 0, percent: null },
    thinking: "off",
    context: () => host.contextUsage,
    model: () => host.activeModel,
    thinkingLevel: () => host.thinking,
    sessionName: () => host.sessionTitle,
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

export type FakeChild = ChildSession & {
  spec: SpawnSpec;
  task?: string;
  messages: { message: RoutedMessage; delivery: MessageDelivery }[];
  wakes: string[];
  aborted: boolean;
  abortDelayMs?: number;
  abortHangs?: boolean;
  disposed: boolean;
  usage: UsageTotals;
  text: string;
  emit(event: ChildEvent): void;
  finish(
    text: string,
    options?: { stopReason?: "stop" | "error" | "aborted"; aborted?: boolean; error?: string },
  ): void;
  turn(context: Partial<ContextSnapshot>, stopReason?: StopReason, toolCalls?: number): void;
};

export const usageOf = (cost: number, tokens = 100): UsageTotals => ({
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: 0,
  totalTokens: tokens * 3,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

const createFakeChild = (spec: SpawnSpec): FakeChild => {
  const listeners = new Set<(event: ChildEvent) => void>();

  const child: FakeChild = {
    id: spec.id,
    sessionFile: `${spec.sessionDir}/session.jsonl`,
    spec,
    messages: [],
    wakes: [],
    aborted: false,
    disposed: false,
    usage: emptyUsage(),
    text: "",
    start: (task) => {
      child.task = task;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: async (message, delivery) => {
      child.messages.push({ message, delivery });
    },
    wake: async (text) => {
      child.wakes.push(text);
    },
    abort: async () => {
      if (child.abortHangs) {
        return new Promise<void>(() => {});
      }

      if (child.abortDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, child.abortDelayMs));
      }

      child.aborted = true;
      child.emit({ type: "settled", aborted: true });
    },
    dispose: async () => {
      child.disposed = true;
    },
    ownUsage: () => child.usage,
    lastText: () => child.text,
    emit: (event) => {
      [...listeners].forEach((listener) => {
        listener(event);
      });
    },
    finish: (text, options = {}) => {
      child.text = text;
      child.emit({
        type: "assistant_message",
        text,
        stopReason: options.stopReason ?? "stop",
        toolCalls: 0,
        errorMessage: options.error,
      });
      child.emit({ type: "settled", aborted: options.aborted ?? false });
    },
    turn: (context, stopReason = "toolUse", toolCalls = stopReason === "toolUse" ? 1 : 0) => {
      child.emit({ type: "assistant_message", text: "", stopReason, toolCalls });
      child.emit({
        type: "turn_end",
        context: {
          tokens: context.tokens ?? 0,
          window: context.window ?? 200_000,
          percent: context.percent ?? 0,
        },
      });
    },
  };

  return child;
};

export const catalogModel = (
  ref: string,
  authenticated = true,
  patch: Partial<CatalogModel> = {},
): CatalogModel => ({
  provider: ref.slice(0, ref.indexOf("/")),
  id: ref.slice(ref.indexOf("/") + 1),
  contextWindow: 200_000,
  cost: { input: 1, output: 5 },
  authenticated,
  ...patch,
});

type FakeRuntime = AgentRuntime & {
  catalog: CatalogModel[];
  preferences: ModelPreferences;
  children: FakeChild[];
  sessions: Map<string, SessionRecord>;
  failNextSpawn?: string;
  child(id: string): FakeChild;
};

export const createFakeRuntime = (extraModels: CatalogModel[] = []): FakeRuntime => {
  const runtime: FakeRuntime = {
    catalog: [
      catalogModel("fake/model"),
      catalogModel("beta/nova-6-luna"),
      catalogModel("beta/nova-6-sol"),
      catalogModel("beta/nova-6.1-sol"),
      catalogModel("acme/lyra-4-5"),
      catalogModel("acme/lyra-4-5-20251001"),
      catalogModel("acme/lyra-5-5", true, { cost: { input: 0.1, output: 0.5 } }),
      catalogModel("locked/lyra-9-0", false),
      ...extraModels,
    ],
    preferences: { sessionProvider: "fake" },
    resolveModel: (request) => resolveModel(request ?? "fake/model", runtime.catalog, runtime.preferences),
    defaultThinking: () => "medium",
    estimateTokens: (text) => Math.ceil(text.length / 4),
    children: [],
    sessions: new Map(),
    spawn: async (spec) => {
      if (runtime.failNextSpawn) {
        const message = runtime.failNextSpawn;

        runtime.failNextSpawn = undefined;
        throw new Error(message);
      }

      const child = createFakeChild(spec);

      runtime.children.push(child);

      return child;
    },
    readSession: (file) => {
      const record = runtime.sessions.get(file);

      if (!record) {
        throw new Error(`no session ${file}`);
      }

      return record;
    },
    child: (id) => {
      const found = runtime.children.find((child) => child.id === id);

      if (!found) {
        throw new Error(`no child ${id}`);
      }

      return found;
    },
  };

  return runtime;
};

export const flush = async (rounds = 5) => {
  await Array.from({ length: rounds }).reduce<Promise<void>>(
    (chain) => chain.then(() => new Promise<void>((done) => setImmediate(done))),
    Promise.resolve(),
  );
};

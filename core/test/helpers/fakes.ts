import {
  type AgentRuntime,
  type ChildEvent,
  type ChildSession,
  type CommandSpec,
  type ContextSnapshot,
  type EditorFrame,
  emptyUsage,
  type FooterRender,
  type Host,
  type InputPane,
  type MessageDelivery,
  type ModelInfo,
  type NewSessionOptions,
  type OverlayFactory,
  type RoutedMessage,
  type SessionControl,
  type SessionInfo,
  type SessionRecord,
  type ShutdownReason,
  type SpawnSpec,
  type StopReason,
  type ThemeLike,
  type ToolSpec,
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
  dispatched: string[];
  published: { channel: string; data: unknown }[];
  notices: { message: string; level?: string }[];
  terminalNotices: { title: string; body: string }[];
  statuses: Map<string, string | undefined>;
  widgets: Map<string, ((width: number, theme: ThemeLike) => string[]) | undefined>;
  widgetRefreshes: number;
  overlays: OverlayFactory[];
  editorFrame?: EditorFrame;
  foreignEditor: boolean;
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
  workingIndicators: (WorkingIndicator | undefined)[];
  workingMessages: (string | undefined)[];
  turnStart(): void;
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
};

export const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

export const createFakeHost = (info: Partial<SessionInfo> = {}): FakeHost => {
  const startHandlers: ((info: SessionInfo, parent?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  const turnHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const turnStartHandlers: (() => void)[] = [];
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const deferred: { name: string; args?: string }[] = [];
  let started = false;
  let stale = false;
  let settling = false;

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
    dispatched: [],
    published: [],
    notices: [],
    terminalNotices: [],
    statuses: new Map(),
    widgets: new Map(),
    widgetRefreshes: 0,
    overlays: [],
    foreignEditor: false,
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
      input: async () => undefined,
      setWidget: (key, render) => {
        host.widgets.set(key, render);
        return {
          refresh: () => {
            host.widgetRefreshes += 1;
          },
        };
      },
      openOverlay: async (factory) => {
        host.overlays.push(factory);
      },
      select: async () => undefined,
      style: (token, text) => `<${token}>${text}`,
      terminalNotify: (title, body) => {
        host.terminalNotices.push({ title, body });
      },
      setWorkingIndicator: (indicator) => {
        host.workingIndicators.push(indicator);
      },
      setWorkingMessage: (text) => {
        host.workingMessages.push(text);
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
          return false;
        }

        host.editorFrame = frame;
        return true;
      },
      setFooter: (render) => {
        host.footer = render;
        return {
          refresh: () => {
            host.footerRefreshes += 1;
          },
        };
      },
      keyText: (binding) => `<${binding}>`,
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
    workingIndicators: [],
    workingMessages: [],
    onTurnStart: (handler) => {
      turnStartHandlers.push(handler);
    },
    turnStart: () => {
      host.idle = false;

      turnStartHandlers.forEach((handler) => {
        handler();
      });
    },
    footerRefreshes: 0,
    contextUsage: { tokens: null, window: 0, percent: null },
    thinking: "off",
    context: () => host.contextUsage,
    model: () => host.activeModel,
    thinkingLevel: () => host.thinking,
    sessionName: () => host.sessionTitle,
  };

  return host;
};

export const createFakeInputPane = (): InputPane & { isFocused(): boolean } => {
  let value = "";
  let focused = true;

  return {
    feed: (key) => {
      if (key.name === "enter") {
        return "submitted";
      }

      if (key.name === "escape") {
        return "cancelled";
      }

      if (key.raw === "\x7f") {
        value = value.slice(0, -1);
        return "changed";
      }

      value += key.char ?? "";

      return "changed";
    },
    value: () => value,
    setValue: (next) => {
      value = next;
    },
    setFocused: (next) => {
      focused = next;
    },
    isFocused: () => focused,
    render: () => [value.length > 0 ? value : "(type a message)"],
  };
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

export const createFakeRuntime = (): FakeRuntime => {
  const runtime: FakeRuntime = {
    catalog: [
      catalogModel("fake/model"),
      catalogModel("openai/gpt-6-luna"),
      catalogModel("openai/gpt-6-sol"),
      catalogModel("openai/gpt-6.1-sol"),
      catalogModel("anthropic/claude-haiku-4-5"),
      catalogModel("anthropic/claude-haiku-4-5-20251001"),
      catalogModel("anthropic/claude-haiku-5-5", true, { cost: { input: 0.1, output: 0.5 } }),
      catalogModel("locked/claude-haiku-9-0", false),
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

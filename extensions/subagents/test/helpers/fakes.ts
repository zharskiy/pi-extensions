import {
  type AgentRuntime,
  type ChildEvent,
  type ChildSession,
  type CommandSpec,
  type ContextSnapshot,
  emptyUsage,
  type Host,
  type InputOutcome,
  type InputPane,
  type KeyPress,
  type MessageDelivery,
  type OverlayFactory,
  type RoutedMessage,
  type SessionInfo,
  type SessionRecord,
  type ShutdownReason,
  type SpawnSpec,
  type ThemeLike,
  type ToolSpec,
  type UsageTotals,
} from "../../src/adapter/contract.ts";
import { type CatalogModel, type ModelPreferences, resolveModel } from "../../src/adapter/model-resolver.ts";

export const plainTheme: ThemeLike = { fg: (_token, text) => text, bold: (text) => text };

export type FakeHost = Host & {
  tools: Map<string, ToolSpec<never, never>>;
  commands: Map<string, CommandSpec>;
  sections: Map<string, string>;
  mainPrompt?: string;
  entries: { customType: string; data: unknown }[];
  sent: string[];
  published: { channel: string; data: unknown }[];
  notices: { message: string; level?: string }[];
  statuses: Map<string, string | undefined>;
  widgets: Map<string, ((width: number, theme: ThemeLike) => string[]) | undefined>;
  widgetRefreshes: number;
  overlays: OverlayFactory[];
  idle: boolean;
  usage: UsageTotals;
  info: SessionInfo;
  confirmations: { title: string; message: string }[];
  confirmAnswer: boolean | ((title: string, message: string) => boolean);
  inputs: { title: string; placeholder?: string }[];
  inputAnswer?: string;
  start(): void;
  settle(): void;
  runCommand(name: string, args?: string): Promise<void>;
  shutdown(reason: ShutdownReason): Promise<void>;
  tool<P, D>(name: string): ToolSpec<P, D>;
};

export const createFakeHost = (info: Partial<SessionInfo> = {}): FakeHost => {
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  let started = false;

  const host: FakeHost = {
    tools: new Map(),
    commands: new Map(),
    sections: new Map(),
    entries: [],
    sent: [],
    published: [],
    notices: [],
    statuses: new Map(),
    widgets: new Map(),
    widgetRefreshes: 0,
    overlays: [],
    idle: true,
    usage: emptyUsage(),
    confirmations: [],
    confirmAnswer: true,
    inputs: [],
    info: {
      id: "main-session",
      file: undefined,
      dir: "/tmp/pi-subagents-test",
      cwd: "/tmp/pi-subagents-test",
      agentDir: "/tmp/pi-subagents-test/agent",
      projectTrusted: false,
      hasUI: true,
      subscription: false,
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
      input: async (title, placeholder) => {
        host.inputs.push({ title, placeholder });

        return host.inputAnswer;
      },
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
    },
    registerTool: (spec) => {
      host.tools.set(spec.name, spec as unknown as ToolSpec<never, never>);
    },
    registerCommand: (name, spec) => {
      host.commands.set(name, spec);
    },
    setPromptSection: (name, text) => {
      host.sections.set(name, text);
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
    isIdle: () => host.idle,
    sendUserMessage: (text) => {
      host.sent.push(text);
    },
    publish: (channel, data) => {
      host.published.push({ channel, data: structuredClone(data) });
    },
    appendEntry: (customType, data) => {
      host.entries.push({ customType, data: structuredClone(data) });
    },
    readEntries: <T>(customType: string) =>
      host.entries.filter((entry) => entry.customType === customType).map((entry) => entry.data as T),
    sessionUsage: () => host.usage,
    session: () => (started ? host.info : undefined),
    start: () => {
      started = true;

      startHandlers.forEach((handler) => {
        handler(host.info);
      });
    },
    settle: () => {
      host.idle = true;

      idleHandlers.forEach((handler) => {
        handler();
      });
    },
    runCommand: async (name, args = "") => {
      const spec = host.commands.get(name);

      if (!spec) {
        throw new Error(`command ${name} not registered`);
      }

      await spec.run(args);
    },
    shutdown: async (reason) => {
      await Promise.all(shutdownHandlers.map((handler) => handler(reason)));
    },
    tool: <P, D>(name: string) => {
      const spec = host.tools.get(name);

      if (!spec) {
        throw new Error(`tool ${name} not registered`);
      }

      return spec as unknown as ToolSpec<P, D>;
    },
  };

  return host;
};

export const createFakeInputPane = (): InputPane & { isFocused(): boolean } => {
  let value = "";
  let focused = true;

  const feed = (key: KeyPress): InputOutcome => {
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
  };

  return {
    feed,
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
  disposed: boolean;
  usage: UsageTotals;
  text: string;
  emit(event: ChildEvent): void;
  finish(
    text: string,
    options?: { stopReason?: "stop" | "error" | "aborted"; aborted?: boolean; error?: string },
  ): void;
  turn(context: Partial<ContextSnapshot>): void;
};

export const usageOf = (cost: number, tokens = 100): UsageTotals => ({
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: 0,
  totalTokens: tokens * 3,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const createFakeChild = (spec: SpawnSpec): FakeChild => {
  const listeners = new Set<(event: ChildEvent) => void>();

  const child: FakeChild = {
    id: spec.id,
    sessionFile: `${spec.sessionDir}/session.jsonl`,
    modelLabel: "fake/model",
    contextWindow: 200_000,
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
      child.aborted = true;
      child.emit({ type: "settled", aborted: true });
    },
    dispose: async () => {
      child.disposed = true;
    },
    context: () => ({ tokens: 0, window: 200_000, percent: 0 }),
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
        errorMessage: options.error,
      });
      child.emit({ type: "settled", aborted: options.aborted ?? false });
    },
    turn: (context) => {
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

export const fakeCatalog = (): CatalogModel[] => [
  catalogModel("fake/model"),
  catalogModel("openai/gpt-6-luna"),
  catalogModel("openai/gpt-6-sol"),
  catalogModel("openai/gpt-6.1-sol"),
  catalogModel("anthropic/claude-haiku-4-5"),
  catalogModel("anthropic/claude-haiku-4-5-20251001"),
  catalogModel("anthropic/claude-haiku-5-5", true, { cost: { input: 0.1, output: 0.5 } }),
  catalogModel("locked/claude-haiku-9-0", false),
];

export type FakeRuntime = AgentRuntime & {
  catalog: CatalogModel[];
  preferences: ModelPreferences;
  children: FakeChild[];
  sessions: Map<string, SessionRecord>;
  failNextSpawn?: string;
  spawned: Promise<FakeChild>[];
  child(id: string): FakeChild;
};

export const createFakeRuntime = (): FakeRuntime => {
  const runtime: FakeRuntime = {
    catalog: fakeCatalog(),
    preferences: { sessionProvider: "fake" },
    resolveModel: (request) => resolveModel(request ?? "fake/model", runtime.catalog, runtime.preferences),
    defaultThinking: () => "medium",
    children: [],
    sessions: new Map(),
    spawned: [],
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

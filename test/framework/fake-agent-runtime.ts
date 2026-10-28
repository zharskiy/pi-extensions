import {
  type AgentRuntime,
  type CatalogModel,
  type ChildEvent,
  type ChildSession,
  type CodemodeShortfall,
  type ContextSnapshot,
  type CustomMessage,
  emptyUsage,
  type MessageDelivery,
  type ModelPreferences,
  type RoutedMessage,
  resolveModel,
  type SessionRecord,
  type SpawnSpec,
  type StopReason,
  THINKING_LEVELS,
  type UsageTotals,
} from "../../platform/pi-adapter/index.ts";

export type FakeChildSession = ChildSession & {
  spec: SpawnSpec;
  task?: string;
  seed?: CustomMessage;
  messages: { message: RoutedMessage | CustomMessage; delivery: MessageDelivery }[];
  wakes: string[];
  aborted: boolean;
  abortDelayMs?: number;
  abortHangs?: boolean;
  disposed: boolean;
  usage: UsageTotals;
  text: string;
  texts?: string[];
  emit(event: ChildEvent): void;
  finish(
    text: string,
    options?: { stopReason?: "stop" | "error" | "aborted"; aborted?: boolean; error?: string },
  ): void;
  turn(context: Partial<ContextSnapshot>, stopReason?: StopReason, toolCalls?: number): void;
};

const createFakeChild = (spec: SpawnSpec): FakeChildSession => {
  const listeners = new Set<(event: ChildEvent) => void>();

  const child: FakeChildSession = {
    id: spec.id,
    sessionFile: `${spec.sessionDir}/session.jsonl`,
    spec,
    messages: [],
    wakes: [],
    aborted: false,
    disposed: false,
    usage: emptyUsage(),
    text: "",
    start: (task, seed) => {
      child.task = task;
      child.seed = seed;
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
    sendCustom: async (message, delivery) => {
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
    runTexts: () => child.texts ?? (child.text.trim() ? [child.text.trim()] : []),
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

export type FakeAgentRuntime = AgentRuntime & {
  catalog: CatalogModel[];
  preferences: ModelPreferences;
  children: FakeChildSession[];
  sessions: Map<string, SessionRecord>;
  failNextSpawn?: string;
  skills: string[];
  sessionSkills?: string[];
  skillDescriptions: Record<string, string>;
  skillPaths: Record<string, string>;
  workerRequests: number[];
  codemodeShortfall: CodemodeShortfall | undefined;
  child(id: string): FakeChildSession;
};

export const createFakeAgentRuntime = (extraModels: CatalogModel[] = []): FakeAgentRuntime => {
  const runtime: FakeAgentRuntime = {
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
    availableModels: () =>
      runtime.catalog
        .filter((model) => model.authenticated)
        .map((model) => ({
          ref: `${model.provider}/${model.id}`,
          contextWindow: model.contextWindow,
          cost: model.cost,
          thinking: [...THINKING_LEVELS],
        }))
        .sort((left, right) => left.ref.localeCompare(right.ref)),
    defaultThinking: () => "medium",
    skills: [],
    skillDescriptions: {},
    skillPaths: {},
    skillCatalog: () =>
      runtime.skills.map((name) => ({
        name,
        description: runtime.skillDescriptions[name] ?? "",
        scope: "user",
        path: runtime.skillPaths[name] ?? `/skills/${name}/SKILL.md`,
      })),
    skillNames: () => runtime.skillCatalog().map((skill) => skill.name),
    sessionSkills: undefined,
    sessionSkillNames: () => runtime.sessionSkills ?? runtime.skillNames(),
    workerRequests: [],
    codemodeShortfall: undefined,
    reserveCodemodeWorkers: (agentSessions) => {
      runtime.workerRequests.push(agentSessions);

      return runtime.codemodeShortfall;
    },
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

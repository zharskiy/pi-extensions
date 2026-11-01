import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushMicrotasks } from "../../../test/framework/index.ts";
import type { ParentSource } from "../child/child-extension.ts";
import { childToolNames, createPiRuntime } from "../child/child-runtime.ts";
import type { SkillInfo, SpawnSpec } from "../index.ts";

type InlineEntry = {
  name: string;
  factory: unknown;
  hidden?: boolean;
  replaceable?: boolean;
  builtin?: boolean;
};

type LoaderSkill = { name: string };

type LoaderOptions = {
  extensionFactories: unknown[];
  noSkills?: boolean;
  additionalSkillPaths?: string[];
  skillsOverride?: (base: { skills: LoaderSkill[]; diagnostics: unknown[] }) => { skills: LoaderSkill[] };
};

const captured = vi.hoisted(() => ({
  loaderOptions: [] as LoaderOptions[],
  sessionOptions: [] as { tools?: string[]; customTools?: { name: string }[] }[],
  session: undefined as unknown,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();

  class FakeLoader {
    constructor(options: LoaderOptions) {
      captured.loaderOptions.push(options);
    }

    reload = async () => {};
  }

  const fakeSession = {
    bindExtensions: async () => {},
    subscribe: () => () => {},
    sessionFile: undefined,
  };

  return {
    ...actual,
    DefaultResourceLoader: FakeLoader,
    ModelRuntime: { create: async () => ({}) },
    SessionManager: { create: () => ({}) },
    createAgentSession: async (options: { tools?: string[]; customTools?: { name: string }[] }) => {
      captured.sessionOptions.push(options);

      return { session: captured.session ?? fakeSession };
    },
  };
});

const fakeModel = { provider: "fake", id: "model", contextWindow: 100_000, cost: { input: 1, output: 1 } };

const otherModel = {
  provider: "acme",
  id: "model-b",
  contextWindow: 400_000,
  cost: { input: 1, output: 1 },
};

const parentCtx = {
  model: fakeModel,
  modelRegistry: { getAll: () => [fakeModel, otherModel], hasConfiguredAuth: () => true },
  isProjectTrusted: () => false,
  ui: { theme: {} },
};

const runtimeWith = (parent: Partial<ParentSource> = {}, exclude: string[] = []) =>
  createPiRuntime(
    {
      ctx: () => parentCtx as never,
      settings: () => ({}) as never,
      thinking: () => "off",
      inventorySkillFiles: () => [],
      sessionSkillFiles: () => [],
      activeTools: () => [],
      mcpDisabled: () => false,
      ...parent,
    },
    { namespace: "test-ext", exclude },
  );

const runtime = runtimeWith();

const spec = (overrides: Partial<SpawnSpec>): SpawnSpec => ({
  id: "a1",
  cwd: tmpdir(),
  sessionDir: join(tmpdir(), "a1"),
  model: "fake/model",
  thinking: "off",
  customTools: [],
  promptAppend: [],
  reserveTokens: 16_384,
  skills: [],
  ...overrides,
});

const factoriesOf = (index: number) => captured.loaderOptions[index].extensionFactories as InlineEntry[];

const EVERY_MCP = [
  "codemode",
  "tool_search",
  "mcp__*",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

const MCP_BUILTINS = ["codemode", "tool-search", "mcp"];

describe("child session MCP", () => {
  beforeEach(() => {
    captured.loaderOptions.length = 0;
    captured.sessionOptions.length = 0;
  });

  it("loads pi's MCP built-ins and adds every MCP tool to a named tool list", async () => {
    await runtime.spawn(spec({ tools: ["read", "grep"] }));

    const factories = factoriesOf(0);

    expect(factories.map((entry) => entry.name)).toEqual(["test-ext-child", ...MCP_BUILTINS]);
    expect(factories.slice(1).every((entry) => entry.builtin && entry.replaceable)).toBe(true);
    expect(factories.every((entry) => typeof entry.factory === "function")).toBe(true);
    expect(captured.sessionOptions[0].tools).toEqual(["read", "grep", ...EVERY_MCP]);
  });

  it("loads no MCP built-in and passes an empty list for tools: []", async () => {
    await runtime.spawn(spec({ tools: [] }));

    expect(factoriesOf(0).map((entry) => entry.name)).toEqual(["test-ext-child"]);
    expect(captured.sessionOptions[0].tools).toEqual([]);
  });

  it("gives tools: all the main session's active tools without MCP or own tools, then every MCP tool", async () => {
    const withParent = runtimeWith(
      {
        activeTools: () => [
          { name: "read", path: "builtin:read" },
          { name: "grep", path: "builtin:grep" },
          { name: "web_fetch", path: "/ext/web/index.ts" },
          { name: "run_agent", path: "/own/src/index.ts" },
          { name: "codemode", path: "builtin:codemode" },
          { name: "mcp__slack__post", path: "builtin:mcp" },
          { name: "mcp__other__get", path: "/ext/other-mcp/index.ts" },
          { name: "read_mcp_resource", path: "builtin:mcp" },
        ],
      },
      ["/own/src"],
    );

    await withParent.spawn(spec({}));

    expect(factoriesOf(0).map((entry) => entry.name)).toEqual(["test-ext-child", ...MCP_BUILTINS]);
    expect(captured.sessionOptions[0].tools).toEqual(["read", "grep", "web_fetch", ...EVERY_MCP]);
  });

  it("binds the agent's own handoff tool when another extension's tool of that name is active in the main session", async () => {
    const withMain = runtimeWith({
      activeTools: () => [
        { name: "read", path: "builtin:read" },
        { name: "handoff", path: "/ext/session-limits/index.ts" },
      ],
    });

    const own = {
      name: "handoff",
      label: "handoff",
      description: "the agent's own",
      parameters: {},
      execute: async () => ({ text: "" }),
    };

    await withMain.spawn(spec({ customTools: [own] }));

    const [options] = captured.sessionOptions;

    expect(options.tools?.filter((name) => name === "handoff")).toHaveLength(1);
    expect(options.customTools?.map((tool) => tool.name)).toEqual(["handoff"]);
  });

  it("ignores relative exclude entries instead of resolving them against the working directory", async () => {
    const withRelative = runtimeWith(
      {
        activeTools: () => [
          { name: "read", path: "builtin:read" },
          { name: "run_agent", path: join(process.cwd(), "own", "src", "index.ts") },
        ],
      },
      [join("own", "src")],
    );

    await withRelative.spawn(spec({}));

    expect(captured.sessionOptions[0].tools).toEqual(["read", "run_agent", ...EVERY_MCP]);
  });

  it("keeps codemode and tool search but no MCP built-in or MCP tool names for mcp: false", async () => {
    await runtime.spawn(spec({ tools: ["read"], mcp: false }));
    await runtime.spawn(spec({ id: "a2", tools: [], mcp: false }));

    expect(factoriesOf(0).map((entry) => entry.name)).toEqual(["test-ext-child", "codemode", "tool-search"]);
    expect(factoriesOf(1).map((entry) => entry.name)).toEqual(["test-ext-child"]);
    expect(captured.sessionOptions[0].tools).toEqual(["read", "codemode", "tool_search"]);
    expect(captured.sessionOptions[1].tools).toEqual([]);
  });

  it("leaves out pi's MCP built-in but keeps codemode and tool search when the main session has MCP off", async () => {
    const withoutMcp = runtimeWith({ mcpDisabled: () => true });

    await withoutMcp.spawn(spec({ tools: ["read"] }));
    await withoutMcp.spawn(spec({ id: "a2", tools: [] }));

    expect(factoriesOf(0).map((entry) => entry.name)).toEqual(["test-ext-child", "codemode", "tool-search"]);
    expect(factoriesOf(1).map((entry) => entry.name)).toEqual(["test-ext-child"]);
    expect(captured.sessionOptions[0].tools).toEqual(["read", ...EVERY_MCP]);
  });
});

describe("child tool names", () => {
  it("appends every MCP tool and then the custom tools, without duplicates", () => {
    expect(childToolNames({ tools: ["read", "codemode"], customNames: ["run_agent"] }, () => [])).toEqual([
      "read",
      ...EVERY_MCP,
      "run_agent",
    ]);
    expect(childToolNames({ tools: undefined, customNames: ["run_agent"] }, () => ["read"])).toEqual([
      "read",
      ...EVERY_MCP,
      "run_agent",
    ]);
  });

  it("appends only codemode and tool search without MCP", () => {
    expect(childToolNames({ tools: ["read"], customNames: ["run_agent"], mcp: false }, () => [])).toEqual([
      "read",
      "codemode",
      "tool_search",
      "run_agent",
    ]);
    expect(childToolNames({ tools: [], customNames: [], mcp: false }, () => ["read"])).toEqual([]);
  });

  it("keeps only the custom tools for []", () => {
    expect(childToolNames({ tools: [], customNames: [] }, () => ["read"])).toEqual([]);
    expect(childToolNames({ tools: [], customNames: ["run_agent"] }, () => ["read"])).toEqual(["run_agent"]);
  });
});

describe("child skills", () => {
  const inventory = (): SkillInfo[] => [
    { name: "docs", description: "Writes docs", scope: "project", path: "/skills/docs/SKILL.md" },
    { name: "git", description: "", scope: "user", path: "/skills/git/SKILL.md" },
    { name: "style", description: "Checks style", scope: "temporary", path: "/skills/style/SKILL.md" },
  ];

  const withSkills = runtimeWith({ inventorySkillFiles: inventory });

  const discovered = {
    skills: [{ name: "docs" }, { name: "git" }, { name: "style" }, { name: "from-extension" }],
    diagnostics: [],
  };

  const keptNames = (options: LoaderOptions) =>
    (options.skillsOverride?.(discovered) ?? discovered).skills.map((skill) => skill.name);

  beforeEach(() => {
    captured.loaderOptions.length = 0;
  });

  it("gives a child the named inventory skill files instead of its own discovery", async () => {
    await withSkills.spawn(spec({ skills: ["docs", "git", "style"] }));
    await withSkills.spawn(spec({ id: "a2", skills: ["docs", "style", "missing"] }));
    await withSkills.spawn(spec({ id: "a3", skills: [] }));

    const [every, named, none] = captured.loaderOptions;

    expect(every).toMatchObject({
      noSkills: true,
      additionalSkillPaths: ["/skills/docs/SKILL.md", "/skills/git/SKILL.md", "/skills/style/SKILL.md"],
    });
    expect(keptNames(every)).toEqual(["docs", "git", "style"]);
    expect(named).toMatchObject({
      noSkills: true,
      additionalSkillPaths: ["/skills/docs/SKILL.md", "/skills/style/SKILL.md"],
    });
    expect(keptNames(named)).toEqual(["docs", "style"]);
    expect(none).toMatchObject({ noSkills: true, additionalSkillPaths: [] });
    expect(keptNames(none)).toEqual([]);
  });

  it("lists the inventory's skills with their descriptions, scopes and paths, and their names alone", () => {
    expect(withSkills.skillCatalog()).toEqual(inventory());
    expect(withSkills.skillNames()).toEqual(["docs", "git", "style"]);
  });
});

type SessionListener = (event: { type: string; aborted?: boolean; message?: unknown }) => void;

const scriptedSession = () => {
  const calls: string[] = [];
  let listener: SessionListener = () => {};
  let promptError: Error | undefined;
  let bindError: Error | undefined;
  const queued: string[] = [];
  const agentQueue: string[] = [];
  const bindings: unknown[] = [];
  const appended: string[] = [];

  const session = {
    isStreaming: false,
    sessionFile: undefined,
    bindExtensions: async (options: unknown) => {
      bindings.push(options);

      if (bindError) {
        throw bindError;
      }
    },
    subscribe: (next: SessionListener) => {
      listener = next;
      return () => {};
    },
    prompt: async (text: string) => {
      calls.push(`prompt ${text}`);

      const error = promptError;

      promptError = undefined;

      if (error) {
        throw error;
      }
    },
    steer: async (text: string) => {
      calls.push(`steer ${text}`);
    },
    followUp: async (text: string) => {
      calls.push(`followUp ${text}`);
    },
    sendCustomMessage: async (
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options: { deliverAs?: string; triggerTurn?: boolean },
    ) => {
      const mode = options.deliverAs ?? (options.triggerTurn ? "trigger" : "append");
      const hidden = message.display ? "" : " (hidden)";

      calls.push(`custom ${message.customType} ${mode} ${message.content}${hidden}`);

      const error = mode === "trigger" ? promptError : undefined;

      promptError = mode === "trigger" ? undefined : promptError;

      if (error) {
        throw error;
      }

      if (mode === "steer" || mode === "followUp") {
        agentQueue.push(`${message.customType} ${message.content}`);
      }

      if (mode === "append") {
        appended.push(message.customType);
      }
    },
    get pendingMessageCount() {
      return queued.length;
    },
    clearQueue: () => {
      agentQueue.length = 0;

      return { steering: queued.splice(0), followUp: [] };
    },
    extensionRunner: {
      emit: async (event: { type: string }) => {
        calls.push(`emit ${event.type}`);
      },
    },
    dispose: () => {
      calls.push("dispose");
    },
  };

  return {
    session,
    calls,
    bindings,
    settle: () => listener({ type: "agent_settled", aborted: false }),
    settleAborted: () => listener({ type: "agent_settled", aborted: true }),
    seen: (customType: string, content: string) =>
      listener({ type: "message_start", message: { role: "custom", customType, content } }),
    agentQueue,
    appended,
    leaveQueued: (text: string) => {
      queued.push(text);
    },
    failNextRun: (error: Error) => {
      promptError = error;
    },
    failBind: (error: Error) => {
      bindError = error;
    },
  };
};

describe("child prompting", () => {
  beforeEach(() => {
    captured.session = undefined;
  });

  const spawnScripted = async () => {
    const scripted = scriptedSession();

    captured.session = scripted.session;

    const child = await runtime.spawn(spec({ tools: [] }));
    const events: string[] = [];

    child.subscribe((event) => {
      events.push(event.type === "assistant_message" ? `error ${event.errorMessage}` : event.type);
    });

    return { ...scripted, child, events };
  };

  const wake = (text: string) => ({ customType: "pi-subagents:wake", text });

  it("queues messages on the running prompt even before pi reports streaming", async () => {
    const { child, calls } = await spawnScripted();

    child.start("task");
    await child.send({ sender: "main", text: "hi" }, "steer");
    await child.wake(wake("more"));

    expect(calls).toEqual([
      "prompt task",
      expect.stringMatching(/^steer .*hi/s),
      "custom pi-subagents:wake nextTurn more (hidden)",
    ]);
  });

  it("wakes an idle child with a hidden custom message that starts a run", async () => {
    const { child, calls, settle } = await spawnScripted();

    child.start("task");
    settle();
    await child.wake(wake("again"));

    expect(calls.at(-1)).toBe("custom pi-subagents:wake trigger again (hidden)");
  });

  it("re-sends a hidden wake still queued at settle as hidden", async () => {
    const { child, calls, events, settle } = await spawnScripted();

    child.start("task");
    await child.wake(wake("more"));
    settle();

    expect(calls.at(-1)).toBe("custom pi-subagents:wake trigger more (hidden)");
    expect(events).toEqual([]);
  });

  it("reports a wake whose run fails after the first turn", async () => {
    const { child, events, settle, failNextRun } = await spawnScripted();

    child.start("task");
    settle();
    failNextRun(new Error("auth expired"));
    await child.wake(wake("go on"));
    await flushMicrotasks(1);

    expect(events).toEqual(["settled", "error Error: auth expired", "settled"]);
  });

  it("runs messages left in pi's queue at settle instead of reporting settled", async () => {
    const { child, calls, events, settle, leaveQueued } = await spawnScripted();

    child.start("task");
    leaveQueued("late");
    settle();

    expect(calls.at(-1)).toBe("prompt late");
    expect(events).toEqual([]);

    settle();

    expect(events).toEqual(["settled"]);
  });

  const request = { customType: "pi-handoff-request", text: "hand off", details: { reason: "limit" } };

  it("sends a custom message to a running child as a displayed custom message, without a sender prefix", async () => {
    const { child, calls, session } = await spawnScripted();

    child.start("task");
    session.isStreaming = true;
    await child.sendCustom(request, "steer");

    expect(calls.at(-1)).toBe("custom pi-handoff-request steer hand off");
  });

  it("queues a custom message sent before pi reports streaming for the starting run instead of starting a second one", async () => {
    const { child, calls, settle, seen } = await spawnScripted();

    child.start("task");
    await child.sendCustom(request, "steer");

    expect(calls.at(-1)).toBe("custom pi-handoff-request nextTurn hand off");
    expect(calls.some((call) => call.includes("trigger"))).toBe(false);

    seen("pi-handoff-request", "hand off");
    settle();

    expect(calls.some((call) => call.includes("trigger"))).toBe(false);
  });

  it("starts a run with a custom message sent to an idle child", async () => {
    const { child, calls, settle, events } = await spawnScripted();

    child.start("task");
    settle();
    await child.sendCustom(request, "steer");
    settle();

    expect(calls.at(-1)).toBe("custom pi-handoff-request trigger hand off");
    expect(events).toEqual(["settled", "settled"]);
  });

  it("runs the queued text and the queued custom message together when the run settles", async () => {
    const { child, calls, events, settle, leaveQueued, agentQueue } = await spawnScripted();

    child.start("task");
    leaveQueued("late");
    await child.sendCustom(request, "steer");
    settle();

    expect(agentQueue).toEqual([]);
    expect(calls.slice(-2)).toEqual(["custom pi-handoff-request nextTurn hand off", "prompt late"]);
    expect(events).toEqual([]);
  });

  it("starts the next run with a custom message that is the only thing pending at settle", async () => {
    const { child, calls, events, settle } = await spawnScripted();

    child.start("task");
    await child.sendCustom(request, "steer");
    settle();

    expect(calls.at(-1)).toBe("custom pi-handoff-request trigger hand off");
    expect(events).toEqual([]);
  });

  it("re-queues only one of two identical custom messages when pi has taken the other", async () => {
    const { child, calls, settle, seen, session } = await spawnScripted();

    child.start("task");
    session.isStreaming = true;
    await child.sendCustom(request, "steer");
    await child.sendCustom(request, "steer");
    seen("pi-handoff-request", "hand off");
    settle();

    expect(calls.filter((call) => call.endsWith("hand off") && !call.includes("steer"))).toEqual([
      "custom pi-handoff-request trigger hand off",
    ]);
  });

  it("delivers nothing on a later send after a dispose dropped a queued custom message", async () => {
    const { child, calls, settle, session } = await spawnScripted();

    child.start("task");
    session.isStreaming = true;
    await child.sendCustom(request, "steer");
    await child.dispose();
    settle();

    expect(calls.some((call) => call.includes("trigger") || call.includes("nextTurn"))).toBe(false);
  });

  it("starts from a seed alone and queues, not prompts, the messages sent while it runs", async () => {
    const { child, calls } = await spawnScripted();

    child.start({ customType: "pi-handoff-seed", text: "the handoff", details: { from: "agent" } });
    await Promise.all([
      child.send({ sender: "main", text: "hi" }, "steer"),
      child.sendCustom(request, "steer"),
    ]);
    await flushMicrotasks(2);

    expect(calls).toEqual([
      "custom pi-handoff-seed trigger the handoff",
      expect.stringMatching(/^steer .*hi/s),
      "custom pi-handoff-request nextTurn hand off",
    ]);
    expect(calls.some((call) => call.startsWith("prompt"))).toBe(false);
  });

  it("never prompts a disposed session", async () => {
    const { child, calls } = await spawnScripted();

    await child.dispose();
    await child.wake(wake("too late"));
    await child.send({ sender: "main", text: "hi" }, "steer");

    expect(calls).toEqual(["emit session_shutdown", "dispose"]);
  });

  it("binds the child's extensions without a UI context", async () => {
    const { bindings } = await spawnScripted();

    expect(bindings).toEqual([{ mode: "print" }]);
    expect(bindings[0]).not.toHaveProperty("uiContext");
  });

  it("shuts down and disposes the session when binding its extensions fails", async () => {
    const scripted = scriptedSession();

    scripted.failBind(new Error("bind failed"));
    captured.session = scripted.session;

    await expect(runtime.spawn(spec({ tools: [] }))).rejects.toThrow("bind failed");
    expect(scripted.calls).toEqual(["emit session_shutdown", "dispose"]);
  });
});

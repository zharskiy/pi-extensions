import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSpec } from "../../adapter/contract.ts";
import { childToolNames, createPiRuntime, type ParentSource } from "../../adapter/pi-child.ts";

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
  sessionOptions: [] as { tools?: string[] }[],
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
    createAgentSession: async (options: { tools?: string[] }) => {
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
      skillFiles: () => [],
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
    expect(childToolNames(["read", "codemode"], ["run_agent"], () => [])).toEqual([
      "read",
      ...EVERY_MCP,
      "run_agent",
    ]);
    expect(childToolNames(undefined, ["run_agent"], () => ["read"])).toEqual([
      "read",
      ...EVERY_MCP,
      "run_agent",
    ]);
  });

  it("keeps only the custom tools for []", () => {
    expect(childToolNames([], [], () => ["read"])).toEqual([]);
    expect(childToolNames([], ["run_agent"], () => ["read"])).toEqual(["run_agent"]);
  });
});

describe("child skills", () => {
  const mainSkills = () => [
    { name: "docs", path: "/skills/docs/SKILL.md" },
    { name: "git", path: "/skills/git/SKILL.md" },
    { name: "style", path: "/skills/style/SKILL.md" },
  ];

  const withSkills = runtimeWith({ skillFiles: mainSkills });

  const discovered = {
    skills: [{ name: "docs" }, { name: "git" }, { name: "style" }, { name: "from-extension" }],
    diagnostics: [],
  };

  const keptNames = (options: LoaderOptions) =>
    (options.skillsOverride?.(discovered) ?? discovered).skills.map((skill) => skill.name);

  beforeEach(() => {
    captured.loaderOptions.length = 0;
  });

  it("gives a child the main session's skill files instead of its own discovery", async () => {
    await withSkills.spawn(spec({}));
    await withSkills.spawn(spec({ id: "a2", skills: ["docs", "style", "missing"] }));
    await withSkills.spawn(spec({ id: "a3", skills: [] }));

    const [all, named, none] = captured.loaderOptions;

    expect(all).toMatchObject({
      noSkills: true,
      additionalSkillPaths: ["/skills/docs/SKILL.md", "/skills/git/SKILL.md", "/skills/style/SKILL.md"],
    });
    expect(keptNames(all)).toEqual(["docs", "git", "style", "from-extension"]);
    expect(named).toMatchObject({
      noSkills: true,
      additionalSkillPaths: ["/skills/docs/SKILL.md", "/skills/style/SKILL.md"],
    });
    expect(keptNames(named)).toEqual(["docs", "style"]);
    expect(none).toMatchObject({ noSkills: true, additionalSkillPaths: [] });
    expect(keptNames(none)).toEqual([]);
  });
});

type SessionListener = (event: { type: string; aborted?: boolean; message?: unknown }) => void;

const scriptedSession = () => {
  const calls: string[] = [];
  let listener: SessionListener = () => {};
  let promptError: Error | undefined;
  let bindError: Error | undefined;
  const queued: string[] = [];
  const bindings: unknown[] = [];

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
    get pendingMessageCount() {
      return queued.length;
    },
    clearQueue: () => ({ steering: queued.splice(0), followUp: [] }),
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
    leaveQueued: (text: string) => {
      queued.push(text);
    },
    failNextPrompt: (error: Error) => {
      promptError = error;
    },
    failBind: (error: Error) => {
      bindError = error;
    },
  };
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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

  it("queues messages on the running prompt even before pi reports streaming", async () => {
    const { child, calls, settle } = await spawnScripted();

    child.start("task");
    await child.send({ sender: "main", text: "hi" }, "steer");
    await child.wake("more");

    expect(calls).toEqual(["prompt task", expect.stringMatching(/^steer .*hi/s), "followUp more"]);

    settle();
    await child.wake("again");

    expect(calls.at(-1)).toBe("prompt again");
  });

  it("reports a wake whose prompt fails after the first turn", async () => {
    const { child, events, settle, failNextPrompt } = await spawnScripted();

    child.start("task");
    settle();
    failNextPrompt(new Error("auth expired"));
    await child.wake("go on");
    await flushMicrotasks();

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

  it("never prompts a disposed session", async () => {
    const { child, calls } = await spawnScripted();

    await child.dispose();
    await child.wake("too late");
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, Host } from "../../adapter/contract.ts";
import {
  createPiExtension,
  createPiHost,
  createToolRestriction,
  parentTools,
} from "../../adapter/pi-adapter.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; customType?: string; data?: unknown };

const ENTRY = "test:restricted-tools";

const fakePi = (tools: string[], entries: Entry[] = [], active = tools) => {
  const handlers = new Map<string, Handler[]>();
  const state = { all: [...tools], active: [...active], sets: [] as string[][], entries };

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    getSettings: () => ({}),
    getThinkingLevel: () => "medium",
    getActiveTools: () => [...state.active],
    getAllTools: () => state.all.map((name) => ({ name, sourceInfo: { path: `/tools/${name}.ts` } })),
    setActiveTools: (names: string[]) => {
      state.sets.push([...names]);
      state.active = names.filter((name) => state.all.includes(name));
    },
    appendEntry: (customType: string, data: unknown) => {
      state.entries.push({ type: "custom", customType, data });
    },
    getCommands: () => [
      { name: "skill:tdd", source: "skill", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
      { name: "review", source: "prompt", sourceInfo: { path: "/prompts/review.md" } },
      { name: "skill:release", source: "skill", sourceInfo: { path: "/skills/release/SKILL.md" } },
    ],
    events: { emit: () => {}, on: () => () => {} },
  };

  const ctx = {
    mode: "print",
    cwd: "/project",
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => "/sessions/s1.jsonl",
      getEntries: () => state.entries,
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: { notify: () => {}, setStatus: () => {} },
  };

  const fire = (event: string, payload: unknown = {}) =>
    Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));

  const register = (name: string) => {
    state.all.push(name);
    state.active.push(name);
  };

  return { pi: pi as unknown as ExtensionAPI, state, fire, register };
};

const agentStart = { systemPromptOptions: { selectedTools: [] } };

const boot = (fake: ReturnType<typeof fakePi>) => {
  const booted: { host?: Host; runtime?: AgentRuntime } = {};

  createPiExtension(
    (host, runtime) => {
      booted.host = host;
      booted.runtime = runtime;
    },
    { root: "/ext", namespace: "test" },
  )(fake.pi);

  return booted as { host: Host; runtime: AgentRuntime };
};

describe("restrictTools", () => {
  it("deactivates only the tools not kept and never activates one", async () => {
    const fake = fakePi(["read", "write", "bash", "edit", "grep"], [], ["read", "bash", "edit"]);
    const { host } = boot(fake);

    await fake.fire("session_start", { reason: "startup" });
    host.restrictTools(["read", "write", "run_agent"]);

    expect(fake.state.sets).toEqual([["read"]]);
    expect(fake.state.active).toEqual(["read"]);
    expect(fake.state.entries).toEqual([
      { type: "custom", customType: ENTRY, data: { removed: ["bash", "edit"] } },
    ]);
  });

  it("makes no pi call and writes no entry when nothing changes", async () => {
    const fake = fakePi(["read", "write"]);
    const { host } = boot(fake);

    await fake.fire("session_start", { reason: "startup" });
    host.restrictTools(["read", "write", "bash"]);
    await fake.fire("before_agent_start", agentStart);

    expect(fake.state.sets).toEqual([]);
    expect(fake.state.entries).toEqual([]);
  });

  it("removes a tool registered after the restriction before the next run", async () => {
    const fake = fakePi(["read", "bash"]);
    const { host } = boot(fake);

    await fake.fire("session_start", { reason: "startup" });
    host.restrictTools(["read"]);
    fake.register("late");
    await fake.fire("before_agent_start", agentStart);
    await fake.fire("before_agent_start", agentStart);

    expect(fake.state.sets).toEqual([["read"], ["read"]]);
    expect(fake.state.active).toEqual(["read"]);
    expect(fake.state.entries.map((entry) => entry.data)).toEqual([
      { removed: ["bash"] },
      { removed: ["bash", "late"] },
    ]);
  });

  it("sets the active tools but appends no entry when the removed set is already stored", async () => {
    const entries: Entry[] = [{ type: "custom", customType: ENTRY, data: { removed: ["bash"] } }];
    const fake = fakePi(["read", "bash"], entries);
    const { host } = boot(fake);

    await fake.fire("session_start", { reason: "resume" });
    host.restrictTools(["read"]);

    expect(fake.state.sets).toEqual([["read"]]);
    expect(fake.state.entries).toHaveLength(1);
  });

  it("keeps a restriction requested before the session starts until the first run", async () => {
    const fake = fakePi(["read", "bash"]);
    const { host } = boot(fake);

    host.restrictTools(["read"]);

    expect(fake.state.sets).toEqual([]);

    await fake.fire("session_start", { reason: "startup" });
    await fake.fire("before_agent_start", agentStart);

    expect(fake.state.active).toEqual(["read"]);
  });

  it("leaves the tool set alone without a restriction", async () => {
    const fake = fakePi(["read", "bash"]);

    createPiHost(fake.pi, { tools: new Map() });
    await fake.fire("session_start", { reason: "startup" });
    await fake.fire("before_agent_start", agentStart);

    expect(fake.state.sets).toEqual([]);
  });
});

describe("parent tools under a restriction", () => {
  it("returns the active tools plus the removed ones while restricted", async () => {
    const fake = fakePi(["read", "write", "bash", "edit"]);
    const state = { tools: new Map() };
    const restriction = createToolRestriction(fake.pi, state, ENTRY);
    const host = createPiHost(fake.pi, state, restriction);

    await fake.fire("session_start", { reason: "startup" });
    host.restrictTools(["read", "write"]);

    expect(fake.state.active).toEqual(["read", "write"]);
    expect(parentTools(fake.pi, restriction).map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "bash",
      "edit",
    ]);
  });

  it("reads the removed tools from the session entry after a resume", async () => {
    const entries: Entry[] = [
      { type: "custom", customType: ENTRY, data: { removed: ["bash"] } },
      { type: "custom", customType: "other", data: { removed: ["grep"] } },
      { type: "custom", customType: ENTRY, data: { removed: ["bash", "edit"] } },
    ];
    const fake = fakePi(["read", "write", "bash", "edit", "grep"], entries, ["read", "write"]);
    const state = { tools: new Map() };
    const restriction = createToolRestriction(fake.pi, state, ENTRY);
    const host = createPiHost(fake.pi, state, restriction);

    await fake.fire("session_start", { reason: "resume" });
    host.restrictTools(["read", "write"]);

    expect(fake.state.sets).toEqual([]);
    expect(parentTools(fake.pi, restriction).map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "bash",
      "edit",
    ]);
  });

  it("merges the stored names when a resumed session removes more", async () => {
    const entries: Entry[] = [{ type: "custom", customType: ENTRY, data: { removed: ["bash"] } }];
    const fake = fakePi(["read", "bash", "edit"], entries, ["read", "edit"]);
    const { host } = boot(fake);

    await fake.fire("session_start", { reason: "resume" });
    host.restrictTools(["read"]);

    expect(fake.state.entries.at(-1)?.data).toEqual({ removed: ["bash", "edit"] });
  });

  it("drops removed names that are no longer registered", async () => {
    const entries: Entry[] = [{ type: "custom", customType: ENTRY, data: { removed: ["gone", "bash"] } }];
    const fake = fakePi(["read", "bash"], entries, ["read"]);
    const state = { tools: new Map() };
    const restriction = createToolRestriction(fake.pi, state, ENTRY);

    createPiHost(fake.pi, state, restriction);
    await fake.fire("session_start", { reason: "resume" });

    expect(parentTools(fake.pi, restriction).map((tool) => tool.name)).toEqual(["read", "bash"]);
  });
});

describe("skillNames", () => {
  it("lists the main session's skill commands without the skill prefix", () => {
    const { runtime } = boot(fakePi(["read"]));

    expect(runtime.skillNames()).toEqual(["tdd", "release"]);
  });
});

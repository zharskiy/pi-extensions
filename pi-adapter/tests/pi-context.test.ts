import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextHost } from "../context/pi-context.ts";
import type { HostState } from "../ui/pi-tui-context.ts";

const offlineModel = {
  id: "offline",
  name: "Offline",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 100,
};

const namedTool = (name: string, exposure?: pi.ToolExposure) => ({
  name,
  label: name,
  description: `${name} tool`,
  parameters: Type.Object({ query: Type.String() }),
  ...(exposure ? { exposure } : {}),
  execute: async () => ({ content: [], details: undefined }),
});

const usage = (input: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output: 5,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (u: ReturnType<typeof usage>, content: unknown[] = []) => ({
  role: "assistant" as const,
  content: content as never,
  api: "acme-api",
  provider: "acme",
  model: "model-a",
  usage: u,
  stopReason: "stop" as const,
  timestamp: 0,
});

const MEMORY = [
  "<project_context>",
  "Project-specific instructions and guidelines:",
  "",
  '<project_instructions path="/repo/AGENTS.md">',
  "x".repeat(400),
  "</project_instructions>",
  "",
  '<project_instructions path="/home/me/.pi/agent/AGENTS.md">',
  "y".repeat(80),
  "</project_instructions>",
  "</project_context>",
].join("\n");

const SKILLS = [
  "<skills>",
  "The following skills provide specialized instructions for specific tasks.",
  "<available_skills>",
  "  <skill>",
  "    <name>code &amp; style</name>",
  "    <description>d</description>",
  "    <location>/s/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
  "</skills>",
].join("\n");

const source = (path: string) => ({ path, source: "local", scope: "temporary", origin: "top-level" });

const toolInfo = (name: string, path: string, exposure = "direct") => ({
  name,
  description: name.toUpperCase(),
  parameters: {},
  exposure,
  sourceInfo: source(path),
});

const fakeApi = (
  tools: unknown[] = [],
  active: string[] = [],
  settings: unknown = { compaction: { reserveTokens: 1_000 } },
) =>
  ({
    getAllTools: () => tools,
    getActiveTools: () => active,
    getSettings: () => settings,
  }) as unknown as Pick<pi.ExtensionAPI, "getAllTools" | "getActiveTools" | "getSettings">;

const ctxOf = (session: pi.SessionManager, prompt = "") =>
  ({
    sessionManager: session,
    model: { ...offlineModel },
    getContextUsage: () => ({ tokens: 5_000, contextWindow: 100_000, percent: 5 }),
    getSystemPrompt: () => prompt,
  }) as unknown as pi.ExtensionContext;

const factsOf = (
  api: ReturnType<typeof fakeApi>,
  session = pi.SessionManager.inMemory("/tmp"),
  prompt = "",
) => contextHost(api, { tools: new Map(), ctx: ctxOf(session, prompt) }).contextFacts();

describe("contextFacts", () => {
  it("splits the system prompt text and lists the active declared tools before the first request", () => {
    const tools = [
      toolInfo("read", "builtin:read"),
      toolInfo("off", "builtin:off"),
      toolInfo("mine", "/ext/index.ts"),
      toolInfo("docs", "builtin:mcp", "deferred"),
      toolInfo("secret", "builtin:mcp", "hidden"),
    ];
    const facts = factsOf(
      fakeApi(tools, ["read", "mine", "docs", "secret"]),
      undefined,
      `intro\n\n${MEMORY}\n\n${SKILLS}\n\n<cwd>\n/repo\n</cwd>`,
    );

    expect(facts).toMatchObject({
      model: "Offline",
      window: 100_000,
      total: 5_000,
      reserve: 1_000,
      messages: [],
    });
    expect(facts?.sections.map((section) => section.name)).toEqual(["project_context", "skills", "prompt"]);
    expect(facts?.sections.slice(0, 2).map((section) => section.text)).toEqual([MEMORY, SKILLS]);
    expect(facts?.sections[2].text).toBe("intro\n\n\n\n\n\n<cwd>\n/repo\n</cwd>");
    expect(facts?.tools).toEqual([
      { name: "read", source: "builtin", onDemand: false, chars: 52 },
      { name: "mine", source: "extension", onDemand: false, chars: 52 },
      { name: "docs", source: "mcp", onDemand: true, chars: 52 },
    ]);
  });

  it("replays the system messages from the projection once pi wrote them", () => {
    const session = pi.SessionManager.inMemory("/tmp");

    session.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "p".repeat(400), skills: SKILLS },
      toolsAdded: [{ name: "mine", description: "Mine", parameters: {} }],
      timestamp: 0,
    } as never);
    session.appendMessage({ role: "user", content: "hello", timestamp: 0 });

    const facts = factsOf(fakeApi([toolInfo("mine", "/ext/index.ts")]), session, "ignored");

    expect(facts?.sections).toEqual([
      { name: "preamble", text: "p".repeat(400) },
      { name: "skills", text: SKILLS },
    ]);
    expect(facts?.tools).toEqual([{ name: "mine", source: "extension", onDemand: false, chars: 52 }]);
    expect(facts?.messages).toEqual([{ role: "user", tokens: 2, blocks: [] }]);
  });

  it("estimates every conversation message and each assistant block, skipping system messages", () => {
    const session = pi.SessionManager.inMemory("/tmp");

    session.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "s".repeat(4_000) },
      timestamp: 0,
    } as never);
    session.appendMessage({ role: "user", content: "u".repeat(40), timestamp: 0 });
    session.appendMessage(
      assistant(usage(1, 0, 0), [
        { type: "text", text: "a".repeat(80) },
        { type: "thinking", thinking: "t".repeat(400) },
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
      ]),
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "1",
      toolName: "bash",
      content: [{ type: "text", text: "r".repeat(800) }],
      isError: false,
      timestamp: 0,
    });

    expect(factsOf(fakeApi(), session)?.messages).toEqual([
      { role: "user", tokens: 10, blocks: [] },
      {
        role: "assistant",
        tokens: 125,
        blocks: [
          { type: "text", tokens: 20 },
          { type: "thinking", tokens: 100 },
          { type: "toolCall", tokens: 5 },
        ],
      },
      { role: "toolResult", tokens: 200, blocks: [] },
    ]);
  });

  it("reserves the compaction reserve only while compaction is on, with model overrides", () => {
    const reserve = (settings: unknown) => factsOf(fakeApi([], [], settings))?.reserve;

    expect(reserve({})).toBe(pi.DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    expect(reserve({ compaction: { enabled: false, reserveTokens: 1 } })).toBe(0);
    expect(reserve({ compaction: { reserveTokens: 2_000 } })).toBe(2_000);
    expect(
      reserve({
        compaction: { reserveTokens: 2_000, modelOverrides: { "fake/offline": { reserveTokens: 3_000 } } },
      }),
    ).toBe(3_000);
  });
});

describe("request usage", () => {
  it("sums only assistant usage of the main session and follows the leaf", () => {
    const session = pi.SessionManager.inMemory("/tmp");
    const host = contextHost(fakeApi(), { tools: new Map(), ctx: ctxOf(session) });

    session.appendMessage({ role: "user", content: "hi", timestamp: 0 });
    session.appendMessage(assistant(usage(10, 80, 10)));
    session.appendMessage({
      role: "toolResult",
      toolCallId: "1",
      toolName: "x",
      content: [],
      isError: false,
      timestamp: 0,
      usage: usage(1_000, 0, 0),
    } as never);

    expect(host.mainRequestUsage()).toEqual({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 });
    expect(host.lastRequestUsage()).toEqual({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 });

    session.appendMessage(assistant(usage(50, 0, 0)));

    expect(host.mainRequestUsage()).toEqual({ input: 60, cacheRead: 80, cacheWrite: 10, output: 10 });
    expect(host.lastRequestUsage()).toEqual({ input: 50, cacheRead: 0, cacheWrite: 0, output: 5 });
  });

  it("measures the session the host now points at", () => {
    const first = pi.SessionManager.inMemory("/tmp");
    const second = pi.SessionManager.inMemory("/tmp");

    first.appendMessage(assistant(usage(10, 80, 10)));
    second.appendMessage(assistant(usage(50, 0, 0)));

    const state: HostState = { tools: new Map(), ctx: ctxOf(first) };
    const host = contextHost(fakeApi(), state);

    expect(host.mainRequestUsage()).toEqual({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 });

    state.ctx = ctxOf(second);

    expect(host.mainRequestUsage()).toEqual({ input: 50, cacheRead: 0, cacheWrite: 0, output: 5 });
  });

  it("measures nothing without a live session", () => {
    const host = contextHost(fakeApi(), { tools: new Map() });

    expect(host.contextFacts()).toBeUndefined();
    expect(host.lastRequestUsage()).toBeUndefined();
    expect(host.mainRequestUsage()).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });
});

describe("pi context against a real session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sees builtin:mcp as the source of MCP tools and system messages in the projection after a request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-"));
    let captured: pi.ExtensionContext | undefined;
    let api: pi.ExtensionAPI | undefined;

    vi.stubEnv("PI_CODING_AGENT_DIR", dir);

    const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new pi.DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      extensionFactories: [
        {
          name: "probe",
          factory: (probe) => {
            api = probe;
            probe.registerProvider("fake", {
              baseUrl: offlineModel.baseUrl,
              apiKey: "offline-key",
              api: "openai-completions",
              models: [{ ...offlineModel, id: offlineModel.id }] as never,
            });
            probe.registerTool(namedTool("probe_tool") as never);
            probe.on("session_start", (_event, ctx) => {
              captured = ctx;
            });
            probe.on("agent_end", (_event, ctx) => {
              captured = ctx;
            });
          },
        },
        {
          name: "mcp",
          builtin: true,
          replaceable: true,
          factory: (mcp) => {
            mcp.registerTool(namedTool("mcp_direct") as never);
            mcp.registerTool(namedTool("mcp_deferred", "deferred") as never);
          },
        },
      ],
    });

    await loader.reload();

    const modelRuntime = await pi.ModelRuntime.create();

    const { session } = await pi.createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      model: offlineModel as never,
      resourceLoader: loader,
      settingsManager,
      sessionManager: pi.SessionManager.inMemory(dir),
    });

    try {
      await session.bindExtensions({ mode: "print" });

      const probe = api as pi.ExtensionAPI;
      const paths = Object.fromEntries(probe.getAllTools().map((tool) => [tool.name, tool.sourceInfo.path]));

      expect(paths).toMatchObject({
        read: "builtin:read",
        mcp_direct: "builtin:mcp",
        mcp_deferred: "builtin:mcp",
      });
      expect(paths.probe_tool).toBe("<inline:probe>");

      const host = contextHost(probe, { tools: new Map(), ctx: captured });
      const before = host.contextFacts();
      const named = (facts: typeof before, kind: string) =>
        facts?.tools.filter((tool) => tool.source === kind).map((tool) => tool.name);

      expect(
        (captured as pi.ExtensionContext).sessionManager
          .buildSessionProjection()
          .messages.some((message) => message.role === "system"),
      ).toBe(false);
      expect(before?.tools.filter((tool) => tool.source === "mcp")).toEqual([
        { name: "mcp_direct", source: "mcp", onDemand: false, chars: expect.any(Number) },
        { name: "mcp_deferred", source: "mcp", onDemand: true, chars: expect.any(Number) },
      ]);
      expect(named(before, "builtin")).toContain("read");
      expect(named(before, "extension")).toEqual(["probe_tool"]);
      expect(before?.sections.map((section) => section.name)).toContain("prompt");

      await session.prompt("hello");

      const ctx = captured as pi.ExtensionContext;

      expect(
        ctx.sessionManager.buildSessionProjection().messages.some((message) => message.role === "system"),
      ).toBe(true);

      const after = contextHost(probe, { tools: new Map(), ctx }).contextFacts();
      const promptChars = (facts: typeof before) =>
        facts?.sections.reduce((sum, section) => sum + section.text.length, 0) ?? 0;

      expect(named(after, "mcp")).toEqual(["mcp_direct", "mcp_deferred"]);
      expect(named(after, "extension")).toEqual(["probe_tool"]);
      expect(after?.messages.map((message) => message.role)).toContain("user");
      expect(after?.sections.map((section) => section.name)).not.toContain("prompt");
      expect(Math.abs(promptChars(after) - promptChars(before))).toBeLessThan(40);
    } finally {
      session.dispose();
    }
  });
});

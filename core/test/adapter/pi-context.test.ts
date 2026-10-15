import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pi from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBreakdown,
  classifyTools,
  contextHost,
  messageBuckets,
  reserveOf,
  sectionsOfPrompt,
  splitSections,
  toolKind,
  toolTokens,
} from "../../adapter/pi-context.ts";
import type { HostState } from "../../adapter/pi-ui.ts";

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

describe("pi context helpers", () => {
  it("maps project_context to memory files per file, skills per skill and the rest to the system prompt", () => {
    const sections = new Map([
      ["preamble", "p".repeat(40)],
      ["project_context", MEMORY],
      ["skills", SKILLS],
    ]);
    const split = splitSections(sections);

    expect(split.memoryFiles.map((part) => part.name)).toEqual([
      "/repo/AGENTS.md",
      "/home/me/.pi/agent/AGENTS.md",
    ]);
    expect(split.memoryFiles[0].tokens).toBeGreaterThan(100);
    expect(split.skills.map((part) => part.name)).toEqual(["code & style"]);

    const all = Array.from(sections.values()).reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
    const parts = [...split.memoryFiles, ...split.skills].reduce((sum, part) => sum + part.tokens, 0);

    expect(split.systemPrompt).toBe(all - parts);
  });

  it("keeps a section it cannot split as one row", () => {
    expect(
      splitSections(new Map([["project_context", "<project_context>\nfree text\n</project_context>"]]))
        .memoryFiles,
    ).toEqual([{ name: "project context", tokens: 12 }]);
  });

  it("parses the memory and skills sections out of the rendered prompt", () => {
    const sections = sectionsOfPrompt(["intro", MEMORY, SKILLS, "<cwd>\n/repo\n</cwd>"].join("\n\n"));

    expect(Array.from(sections.keys())).toEqual(["project_context", "skills", "prompt"]);
    expect(sections.get("project_context")).toBe(MEMORY);
    expect(sections.get("prompt")).toContain("<cwd>");
  });

  it("classifies tools by source path and lists deferred MCP tools at zero", () => {
    expect(
      ["builtin:mcp", "builtin:read", "builtin:tool-search", "/x/index.ts", undefined].map(toolKind),
    ).toEqual(["mcp", "builtin", "builtin", "extension", "extension"]);

    const read = { name: "read", description: "Read", parameters: {} };
    const tools = classifyTools(
      [
        read,
        { name: "mcp_a", description: "", parameters: {} },
        { name: "mine", description: "", parameters: {} },
      ],
      [
        { name: "read", path: "builtin:read", exposure: "direct" },
        { name: "mcp_a", path: "builtin:mcp", exposure: "direct" },
        { name: "mcp_b", path: "builtin:mcp", exposure: "deferred" },
        { name: "mcp_c", path: "builtin:mcp", exposure: "hidden" },
        { name: "mine", path: "/ext/index.ts", exposure: "direct" },
      ],
    );

    expect(tools.builtin).toEqual([{ name: "read", tokens: toolTokens(read) }]);
    expect(tools.mcp.map((part) => part.name)).toEqual(["mcp_a", "mcp_b"]);
    expect(tools.mcp[1].tokens).toBe(0);
    expect(tools.extension.map((part) => part.name)).toEqual(["mine"]);
  });

  it("buckets messages by role and block type with pi's estimate, skipping system messages", () => {
    const buckets = messageBuckets([
      { role: "system", content: "s".repeat(4_000) },
      { role: "user", content: "u".repeat(40), timestamp: 0 },
      assistant(usage(1, 0, 0), [
        { type: "text", text: "a".repeat(80) },
        { type: "thinking", thinking: "t".repeat(400) },
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "bash",
        content: [{ type: "text", text: "r".repeat(800) }],
      },
      { role: "custom", customType: "x", content: "c".repeat(8), display: true, timestamp: 0 },
    ]);

    expect(buckets).toEqual({
      count: 4,
      user: 10,
      assistant: 20,
      thinking: 100,
      toolCalls: pi.estimateTokens(
        assistant(usage(1, 0, 0), [
          { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
        ]) as never,
      ),
      toolResults: 200,
      other: 2,
    });
  });

  it("reserves the compaction reserve only while compaction is on, with model overrides", () => {
    const model = { provider: "acme", id: "m" };

    expect(reserveOf(undefined, model)).toBe(pi.DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    expect(reserveOf({ enabled: false, reserveTokens: 1 }, model)).toBe(0);
    expect(reserveOf({ reserveTokens: 2_000 }, model)).toBe(2_000);
    expect(
      reserveOf({ reserveTokens: 2_000, modelOverrides: { "acme/m": { reserveTokens: 3_000 } } }, model),
    ).toBe(3_000);
  });
});

const fakeApi = (tools: pi.ToolInfo[] = [], active: string[] = []) => {
  const renderers = new Map<string, pi.EntryRenderer>();

  return {
    renderers,
    api: {
      getAllTools: () => tools,
      getActiveTools: () => active,
      getSettings: () => ({ compaction: { reserveTokens: 1_000 } }),
      registerEntryRenderer: (type: string, renderer: pi.EntryRenderer) => {
        renderers.set(type, renderer);
      },
    } as unknown as Pick<
      pi.ExtensionAPI,
      "getAllTools" | "getActiveTools" | "getSettings" | "registerEntryRenderer"
    >,
  };
};

const ctxOf = (session: pi.SessionManager, prompt = "") =>
  ({
    sessionManager: session,
    model: { ...offlineModel },
    getContextUsage: () => ({ tokens: 5_000, contextWindow: 100_000, percent: 5 }),
    getSystemPrompt: () => prompt,
  }) as unknown as pi.ExtensionContext;

describe("contextHost", () => {
  it("sums only assistant usage of the main session, memoised on the leaf", () => {
    const session = pi.SessionManager.inMemory("/tmp");
    const state: HostState = { tools: new Map(), ctx: ctxOf(session) };
    const host = contextHost(fakeApi().api, state);

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

    const first = host.mainRequestUsage();

    expect(first).toEqual({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 });
    expect(host.mainRequestUsage()).toBe(first);
    expect(host.lastRequestUsage()).toEqual(first);

    session.appendMessage(assistant(usage(50, 0, 0)));

    expect(host.mainRequestUsage()).toEqual({ input: 60, cacheRead: 80, cacheWrite: 10, output: 10 });
    expect(host.lastRequestUsage()).toEqual({ input: 50, cacheRead: 0, cacheWrite: 0, output: 5 });
  });

  it("measures nothing without a live session", () => {
    const host = contextHost(fakeApi().api, { tools: new Map() });

    expect(host.contextBreakdown()).toBeUndefined();
    expect(host.lastRequestUsage()).toBeUndefined();
    expect(host.mainRequestUsage()).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });

  it("falls back to the system prompt text and the active direct tools before the first request", () => {
    const source = (path: string) => ({ path, source: "local", scope: "temporary", origin: "top-level" });
    const tools = [
      {
        name: "read",
        description: "Read",
        parameters: {},
        exposure: "direct",
        sourceInfo: source("builtin:read"),
      },
      {
        name: "off",
        description: "Off",
        parameters: {},
        exposure: "direct",
        sourceInfo: source("builtin:off"),
      },
      {
        name: "docs",
        description: "Docs",
        parameters: {},
        exposure: "deferred",
        sourceInfo: source("builtin:mcp"),
      },
    ] as unknown as pi.ToolInfo[];
    const breakdown = buildBreakdown(
      fakeApi(tools, ["read", "docs"]).api,
      ctxOf(pi.SessionManager.inMemory("/tmp"), `intro\n\n${MEMORY}`),
    );

    expect(breakdown).toMatchObject({
      model: "Offline",
      window: 100_000,
      total: 5_000,
      reserve: 1_000,
      skills: [],
      tools: { builtin: [{ name: "read" }], mcp: [{ name: "docs", tokens: 0 }], extension: [] },
      messages: { count: 0 },
    });
    expect(breakdown.memoryFiles).toHaveLength(2);
    expect(breakdown.systemPrompt).toBeGreaterThan(0);
  });

  it("replays system messages from the projection once pi wrote them", () => {
    const session = pi.SessionManager.inMemory("/tmp");

    session.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "p".repeat(400), skills: SKILLS },
      toolsAdded: [{ name: "mine", description: "Mine", parameters: {} }],
      timestamp: 0,
    } as never);
    session.appendMessage({ role: "user", content: "hello", timestamp: 0 });

    const breakdown = buildBreakdown(fakeApi().api, ctxOf(session, "ignored"));

    expect(breakdown.systemPrompt).toBeGreaterThanOrEqual(100);
    expect(breakdown.skills.map((part) => part.name)).toEqual(["code & style"]);
    expect(breakdown.tools.extension.map((part) => part.name)).toEqual(["mine"]);
    expect(breakdown.messages).toMatchObject({ count: 1, user: 2 });
  });

  it("registers an entry renderer that passes pi's data, expanded flag and theme and cuts lines to the width", () => {
    const { api, renderers } = fakeApi();
    const host = contextHost(api, { tools: new Map() });
    const seen: unknown[] = [];
    const theme = { fg: (token: string, text: string) => `${token}:${text}`, bold: (text: string) => text };

    host.registerEntryRenderer("x:entry", (data, width, expanded, themed) => {
      seen.push({ data, width, expanded });
      return [themed.fg("syntaxKeyword", "0123456789"), "ok"];
    });

    const component = renderers.get("x:entry")?.(
      { type: "custom", customType: "x:entry", data: { a: 1 }, id: "e", parentId: null, timestamp: "" },
      { expanded: true },
      theme as unknown as pi.Theme,
    );

    expect(component?.render(12).map((line) => stripVTControlCharacters(line))).toEqual([
      "syntaxKeywo…",
      "ok",
    ]);
    expect(seen).toEqual([{ data: { a: 1 }, width: 12, expanded: true }]);
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

      const before = buildBreakdown(probe, captured as pi.ExtensionContext);

      expect(
        (captured as pi.ExtensionContext).sessionManager
          .buildSessionProjection()
          .messages.some((message) => message.role === "system"),
      ).toBe(false);
      expect(before.tools.mcp).toEqual([
        { name: "mcp_direct", tokens: expect.any(Number) },
        { name: "mcp_deferred", tokens: 0 },
      ]);
      expect(before.tools.builtin.map((part) => part.name)).toContain("read");
      expect(before.tools.extension.map((part) => part.name)).toEqual(["probe_tool"]);
      expect(before.systemPrompt).toBeGreaterThan(100);

      await session.prompt("hello");

      const ctx = captured as pi.ExtensionContext;

      expect(
        ctx.sessionManager.buildSessionProjection().messages.some((message) => message.role === "system"),
      ).toBe(true);

      const after = buildBreakdown(probe, ctx);

      expect(after.tools.mcp.map((part) => part.name)).toEqual(["mcp_direct", "mcp_deferred"]);
      expect(after.tools.extension.map((part) => part.name)).toEqual(["probe_tool"]);
      expect(after.messages.user).toBeGreaterThan(0);
      expect(Math.abs(after.systemPrompt - before.systemPrompt)).toBeLessThan(10);
    } finally {
      session.dispose();
    }
  });
});

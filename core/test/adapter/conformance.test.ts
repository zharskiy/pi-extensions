import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpBuiltinLoaded } from "../../adapter/pi-adapter.ts";
import { childSettings, childToolNames, createChildExtension } from "../../adapter/pi-child.ts";
import { ASSISTANT_DELTA_TYPES } from "../../adapter/pi-phase.ts";
import { promptRecordEntry } from "../../adapter/session-file.ts";

const ADAPTER_PI_MAJOR = 1;

const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

const readJson = (url: URL) => JSON.parse(readFileSync(url, "utf8"));

const declaredPiRanges = (): Record<string, string> =>
  readJson(new URL("../../../package.json", import.meta.url)).devDependencies;

const installedVersion = (name: string): string =>
  readJson(new URL("../package.json", import.meta.resolve(name))).version;

const versionParts = (version: string) => version.split(".").map(Number);

const satisfiesCaret = (version: string, range: string) => {
  const [major, minor, patch] = versionParts(version);
  const [floorMajor, floorMinor, floorPatch] = versionParts(range.slice(1));

  return major === floorMajor && (minor > floorMinor || (minor === floorMinor && patch >= floorPatch));
};

type Handler = (event: unknown) => unknown;

const noMainTools = () => [];

const offlineModel = {
  id: "offline",
  name: "offline",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

const namedTool = (name: string) => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: undefined }),
});

const lateMcpTools: pi.ExtensionFactory = (api) => {
  api.on("session_start", () => {
    [
      "mcp__github__get_issue",
      "mcp__github__list",
      "mcp__my_docs__get_page",
      "mcp__my_docs__delete",
      "mcp__slack__post",
    ]
      .map(namedTool)
      .forEach((tool) => {
        api.registerTool(tool as never);
      });
  });

  api.registerTool(namedTool("web_fetch") as never);
};

const fakeExtensionApi = () => {
  const handlers = new Map<string, Handler[]>();
  const entries: { customType: string; data: unknown }[] = [];

  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  };

  const fire = (event: string, payload: unknown) =>
    (handlers.get(event) ?? []).map((handler) => handler(payload));

  return { api, entries, fire };
};

describe("pi adapter conformance", () => {
  it.each(PI_PACKAGES)("installs a %s inside the declared caret range", (name) => {
    const range = declaredPiRanges()[name];
    const version = installedVersion(name);

    expect(range).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(satisfiesCaret(version, range)).toBe(true);
    expect(versionParts(version)[0]).toBe(ADAPTER_PI_MAJOR);
  });

  it("reports the installed pi version as its VERSION", () => {
    expect(pi.VERSION).toBe(installedVersion("@earendil-works/pi-coding-agent"));
  });

  it("finds every pi export the adapter uses", () => {
    const required = [
      "createAgentSession",
      "createCodemodeExtension",
      "createMcpExtension",
      "createToolSearchExtension",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
      "ModelRuntime",
      "AssistantMessageComponent",
      "UserMessageComponent",
      "ToolExecutionComponent",
      "CustomMessageComponent",
      "createBashToolDefinition",
      "createEditToolDefinition",
      "createFindToolDefinition",
      "createGrepToolDefinition",
      "createLsToolDefinition",
      "createPowerShellToolDefinition",
      "createReadToolDefinition",
      "createWriteToolDefinition",
      "getAgentDir",
      "getMarkdownTheme",
      "initTheme",
      "keyText",
      "getDocsPath",
      "getExamplesPath",
      "getReadmePath",
      "estimateTokens",
      "getLastAssistantUsage",
      "DEFAULT_COMPACTION_SETTINGS",
    ];

    const requiredTui = [
      "Container",
      "isKeyRelease",
      "Key",
      "matchesKey",
      "ScrollView",
      "Text",
      "truncateToWidth",
    ];

    expect(required.filter((name) => !(name in pi))).toEqual([]);
    expect(requiredTui.filter((name) => !(name in tui))).toEqual([]);
  });

  it("names only assistant event types pi has", () => {
    void (ASSISTANT_DELTA_TYPES satisfies readonly pi.MessageUpdateEvent["assistantMessageEvent"]["type"][]);
  });

  it("emits ui_prompt events around every blocking dialog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));
    const seen: unknown[] = [];
    let answer: boolean | undefined;

    try {
      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const settingsManager = pi.SettingsManager.inMemory({});

      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: [
          {
            name: "asker",
            factory: (api) => {
              api.on("ui_prompt_start", (event) => {
                seen.push(event);
              });
              api.on("ui_prompt_end", (event) => {
                seen.push(event);
              });
              api.on("session_start", async (_event, ctx) => {
                answer = await ctx.ui.confirm("Allow bash?", "rm -rf build");
              });
            },
          },
        ],
      });

      await loader.reload();

      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: await pi.ModelRuntime.create(),
        model: offlineModel as never,
        resourceLoader: loader,
        settingsManager,
        sessionManager: pi.SessionManager.inMemory(dir),
      });

      const uiContext = { confirm: async () => true } as unknown as pi.ExtensionUIContext;

      await session.bindExtensions({ mode: "print", uiContext });
      await new Promise((resolve) => setTimeout(resolve, 0));

      session.dispose();
    } finally {
      vi.unstubAllEnvs();
    }

    expect(answer).toBe(true);
    expect(seen).toEqual([
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow bash?" },
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Allow bash?" },
    ]);
  });

  it("exposes the model registry methods the model resolver reads", () => {
    const methods = ["getAll", "find", "hasConfiguredAuth"];

    expect(
      methods.filter((name) => typeof Reflect.get(pi.ModelRegistry.prototype, name) !== "function"),
    ).toEqual([]);
  });

  it("keeps the editor's input history in one array that addToHistory changes in place", () => {
    const editor = new tui.Editor(
      { terminal: { rows: 40 }, requestRender: () => {} } as never,
      { borderColor: (text: string) => text, selectList: {} } as never,
    );
    const history: string[] = ["older"];

    (editor as unknown as { history: string[] }).history = history;
    editor.addToHistory("newer");

    expect((editor as unknown as { history: string[] }).history).toBe(history);
    expect(history).toEqual(["newer", "older"]);
  });

  it("gives children in-memory settings with compaction off, a reserve and no cache warming", () => {
    const snapshot = { compaction: { enabled: true, keepRecentTokens: 20_000 }, defaultProvider: "beta" };
    const settings = pi.SettingsManager.inMemory(childSettings(snapshot, 16_384), { projectTrusted: false });

    expect(settings.getCompactionEnabled()).toBe(false);
    expect(settings.getCompactionReserveTokens()).toBe(16_384);
    expect(childSettings(snapshot, 16_384)).toMatchObject({
      compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      cacheWarming: "off",
      defaultProvider: "beta",
    });
  });

  it("cancels every compaction attempt inside a child", () => {
    const { api, fire } = fakeExtensionApi();

    createChildExtension("a1", "acme/x", promptRecordEntry("test-ext"))(api as never);

    expect(fire("session_before_compact", { reason: "threshold" })).toEqual([{ cancel: true }]);
    expect(fire("session_before_compact", { reason: "overflow" })).toEqual([{ cancel: true }]);
  });

  it("records the first provider request once as the prompt record", () => {
    const { api, entries, fire } = fakeExtensionApi();

    createChildExtension("a1", "acme/x", promptRecordEntry("test-ext"))(api as never);

    fire("before_agent_start", {
      systemPromptOptions: {
        skills: [{ name: "s", description: "d", filePath: "/x" }],
        promptGuidelines: ["g1"],
        toolGuidelines: { read: ["g2"] },
      },
    });
    fire("before_provider_request", { payload: { model: "x", n: 1 } });
    fire("before_provider_request", { payload: { model: "x", n: 2 } });

    expect(entries).toEqual([
      {
        customType: "test-ext:prompt-record",
        data: {
          agentId: "a1",
          model: "acme/x",
          skills: [{ name: "s", description: "d" }],
          guidelines: ["g1", "g2"],
          providerPayload: { model: "x", n: 1 },
        },
      },
    ]);
  });

  describe("tool list filtering", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const sessionTools = async (tools: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));

      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const settingsManager = pi.SettingsManager.inMemory({});

      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: [{ name: "late-mcp", factory: lateMcpTools }],
      });

      await loader.reload();

      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: await pi.ModelRuntime.create(),
        model: offlineModel as never,
        resourceLoader: loader,
        settingsManager,
        sessionManager: pi.SessionManager.inMemory(dir),
        tools,
      });

      await session.bindExtensions({ mode: "print" });

      const names = session.getAllTools().map((tool) => tool.name);
      const active = session.getActiveToolNames();

      session.dispose();

      return { names: names.toSorted(), active: active.toSorted() };
    };

    const LATE_MCP = [
      "mcp__github__get_issue",
      "mcp__github__list",
      "mcp__my_docs__delete",
      "mcp__my_docs__get_page",
      "mcp__slack__post",
    ];

    it("keeps the named tools and every MCP tool, including tools registered after the start", async () => {
      const { names } = await sessionTools(childToolNames(["read"], [], noMainTools));

      expect(names).toEqual([...LATE_MCP, "read"]);
    });

    it("keeps the main session's tools and every MCP tool for tools: all", async () => {
      const { names } = await sessionTools(childToolNames(undefined, [], () => ["read", "web_fetch"]));

      expect(names).toEqual([...LATE_MCP, "read", "web_fetch"]);
    });

    it("keeps no tool at all for tools: []", async () => {
      const { names, active } = await sessionTools(childToolNames([], [], noMainTools));

      expect(names).toEqual([]);
      expect(active).toEqual([]);
    });

    it("keeps a third-party extension's MCP tools registered but inactive for tools: [] with agent tools", async () => {
      const tools = childToolNames([], ["web_fetch"], noMainTools);
      const { names, active } = await sessionTools(tools);

      expect(tools).toEqual(["web_fetch"]);
      expect(names).toEqual([...LATE_MCP, "web_fetch"]);
      expect(active).toEqual(["web_fetch"]);
    });
  });

  describe("main session MCP built-in", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const mainSession = async (options: { disabled?: string[]; extensions?: string[] }) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));
      const seen: pi.ExtensionAPI[] = [];

      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const settingsManager = pi.SettingsManager.inMemory({ extensions: options.extensions });

      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        disabledBuiltinExtensions: options.disabled,
        extensionFactories: [
          {
            name: "probe",
            factory: (api) => {
              seen.push(api);
            },
          },
          { name: "mcp", factory: pi.createMcpExtension(), replaceable: true, builtin: true },
        ],
      });

      await loader.reload();

      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: await pi.ModelRuntime.create(),
        model: offlineModel as never,
        resourceLoader: loader,
        settingsManager,
        sessionManager: pi.SessionManager.inMemory(dir),
      });

      await session.bindExtensions({ mode: "print" });

      const loaded = mcpBuiltinLoaded(seen[0]);

      session.dispose();

      return loaded;
    };

    it("is seen through the /mcp command whose source is builtin:mcp", async () => {
      expect(await mainSession({})).toBe(true);
    });

    it("is missing under --no-mcp and with -builtin:mcp in the extensions setting", async () => {
      expect(await mainSession({ disabled: ["mcp"] })).toBe(false);
      expect(await mainSession({ extensions: ["-builtin:mcp"] })).toBe(false);
    });
  });

  describe("MCP tool names", () => {
    const piModule = (path: string) =>
      import(new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href);

    it("match pi's own names for codemode, tool search, server tools and resource tools", async () => {
      const servers = await piModule("core/mcp-servers.js");
      const codemode = await piModule("extensions/codemode/tool.js");
      const search = await piModule("extensions/tool-search/tool.js");
      const mcpTools = await piModule("extensions/mcp/tools.js");
      const added = childToolNames(["read"], [], noMainTools).filter((name) => name !== "read");
      const serverTool = mcpTools.createMcpToolName("fixture", "code");

      expect(added.filter((name) => !name.includes("*")).toSorted()).toEqual(
        [
          codemode.CODEMODE_TOOL_NAME,
          search.TOOL_SEARCH_TOOL_NAME,
          servers.LIST_MCP_RESOURCES_TOOL,
          servers.LIST_MCP_RESOURCE_TEMPLATES_TOOL,
          servers.READ_MCP_RESOURCE_TOOL,
        ].toSorted(),
      );
      expect(servers.isMcpToolName(serverTool)).toBe(true);
      expect(servers.createToolNameMatcher(added)(serverTool)).toBe(true);
    });
  });
});

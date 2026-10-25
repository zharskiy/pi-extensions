import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { initPiRenderTheme, piRenderContext } from "../../../test/framework/pi/index.ts";
import { createChildExtension } from "../child/child-extension.ts";
import { childSettings, childToolNames } from "../child/child-runtime.ts";
import { CODEMODE_WORKERS_SETTING } from "../child/codemode.ts";
import { availableModels } from "../child/model-catalog.ts";
import { discoverSkills } from "../child/skills.ts";
import { THINKING_LEVELS } from "../index.ts";
import { mcpBuiltinLoaded, sessionSkillFiles } from "../runtime/extension.ts";
import { finalRunTexts } from "../runtime/message-text.ts";
import { ASSISTANT_DELTA_TYPES } from "../runtime/phase.ts";
import { promptRecordEntry } from "../runtime/session-file.ts";
import type { PiToolRenderContext } from "../tools/tool-bridge.ts";
import { BUILTIN_TOOLS, piShipped } from "../tools/tool-rows.ts";
import { capturePiRenderers } from "../tools/transcript.ts";
import { composeLabel, OSC133_ZONE_PREFIX } from "../ui/thinking-label.ts";

const ADAPTER_PI_MAJOR = 1;

const temp = useTempDirs();

const PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

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

  it("caps codemode workers through the setting the adapter raises, in the module and the binary's bundle", () => {
    const dist = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
    const chunks = new URL("./bundle/chunks/", dist);
    const bundled = readdirSync(chunks)
      .filter((name) => /^execute-.*\.js$/.test(name))
      .map((name) => new URL(name, chunks));
    const read = `process.env.${CODEMODE_WORKERS_SETTING}`;

    expect(readFileSync(new URL("./extensions/codemode/execute.js", dist), "utf8")).toContain(read);
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.filter((file) => readFileSync(file, "utf8").includes(read))).not.toEqual([]);
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
      "copyToClipboard",
      "getDocsPath",
      "getExamplesPath",
      "getReadmePath",
      "estimateTokens",
      "getLastAssistantUsage",
      "DEFAULT_COMPACTION_SETTINGS",
      "CustomEditor",
    ];

    const requiredTui = [
      "Container",
      "Editor",
      "isKeyRelease",
      "Key",
      "matchesKey",
      "mixColors",
      "ScrollView",
      "Text",
      "truncateToWidth",
      "TuiMainScreen",
      "wrapTextWithAnsi",
    ];

    expect(required.filter((name) => !(name in pi))).toEqual([]);
    expect(requiredTui.filter((name) => !(name in tui))).toEqual([]);
  });

  it("has the session manager and TUI methods the adapter calls", () => {
    const session = ["buildSessionProjection", "buildContextEntries", "getEntries", "getBranch", "getLeafId"];
    const screen = ["hasOverlay", "showOverlay", "hideOverlay", "requestRender"];

    expect(
      session.filter((name) => typeof Reflect.get(pi.SessionManager.prototype, name) !== "function"),
    ).toEqual([]);
    expect(
      screen.filter((name) => typeof Reflect.get(tui.TuiMainScreen.prototype, name) !== "function"),
    ).toEqual([]);
  });

  it("gives extensions the API and UI methods the adapter calls, and tools their source path and exposure", async () => {
    const dir = temp.make("pi-conformance-");
    const seen: { api?: pi.ExtensionAPI; ui?: pi.ExtensionUIContext } = {};

    try {
      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const settingsManager = pi.SettingsManager.inMemory({});

      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: [
          {
            name: "probe",
            factory: (api) => {
              seen.api = api;
              api.registerTool({ ...namedTool("probe_tool"), exposure: "model-only" } as never);
              api.registerTool({
                ...namedTool("mcp__probe_srv__search"),
                namespace: { name: "mcp__probe_srv", aliases: ["probe"] },
              } as never);
              api.on("session_start", (_event, ctx) => {
                seen.ui = ctx.ui;
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

      await session.bindExtensions({ mode: "print" });

      const api = [
        "registerEntryRenderer",
        "registerToolRenderer",
        "registerMessageRenderer",
        "getSettings",
        "getAllTools",
        "getActiveTools",
        "getCommands",
      ];
      const ui = [
        "custom",
        "getEditorComponent",
        "setEditorComponent",
        "setWidget",
        "onTerminalInput",
        "setHiddenThinkingLabel",
      ];
      const probe = seen.api?.getAllTools().find((tool) => tool.name === "probe_tool");

      expect(api.filter((name) => typeof Reflect.get(seen.api ?? {}, name) !== "function")).toEqual([]);
      expect(ui.filter((name) => typeof Reflect.get(seen.ui ?? {}, name) !== "function")).toEqual([]);
      expect(typeof seen.api?.getSettings()).toBe("object");
      expect(Reflect.has(seen.ui ?? {}, "theme")).toBe(true);
      expect(
        ["getBgAnsi", "italic", "inverse"].filter(
          (name) => typeof Reflect.get(pi.Theme.prototype, name) !== "function",
        ),
      ).toEqual([]);
      expect(typeof probe?.sourceInfo.path).toBe("string");
      expect(probe?.exposure).toBe("model-only");
      expect(
        seen.api?.getAllTools().find((tool) => tool.name === "mcp__probe_srv__search")?.namespace,
      ).toEqual({
        name: "mcp__probe_srv",
        aliases: ["probe"],
      });

      session.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cuts with the ASCII ellipsis inside the width", () => {
    const cut = tui.truncateToWidth("Map the auth module", 10, "...");

    expect(tui.visibleWidth(cut)).toBe(10);
    expect(stripVTControlCharacters(cut)).toBe("Map the...");
  });

  it("names only assistant event types pi has", () => {
    void (ASSISTANT_DELTA_TYPES satisfies readonly pi.MessageUpdateEvent["assistantMessageEvent"]["type"][]);
  });

  it("emits ui_prompt events around every blocking dialog", async () => {
    const dir = temp.make("pi-conformance-");
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

  it("names the same thinking levels as pi", () => {
    expect(
      getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "x", max: "m" } } as never),
    ).toEqual(THINKING_LEVELS);
  });

  it("lists only models with credentials, sorted by ref, with their window, cost and thinking levels", () => {
    const model = (provider: string, id: string, reasoning: boolean) => ({
      ...offlineModel,
      provider,
      id,
      reasoning,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    const models = [model("zeta", "one", true), model("alpha", "two", false), model("locked", "three", true)];
    const ctx = {
      modelRegistry: {
        getAll: () => models,
        hasConfiguredAuth: (candidate: { provider: string }) => candidate.provider !== "locked",
      },
    };

    expect(availableModels(ctx as never)).toEqual([
      { ref: "alpha/two", contextWindow: 1_000, cost: { input: 1, output: 2 }, thinking: ["off"] },
      {
        ref: "zeta/one",
        contextWindow: 1_000,
        cost: { input: 1, output: 2 },
        thinking: ["off", "minimal", "low", "medium", "high"],
      },
    ]);
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

    createChildExtension(promptRecordEntry("test-ext"))(api as never);

    expect(fire("session_before_compact", { reason: "threshold" })).toEqual([{ cancel: true }]);
    expect(fire("session_before_compact", { reason: "overflow" })).toEqual([{ cancel: true }]);
  });

  it("reads the assistant texts of a child's final run from pi's session entries", () => {
    const session = pi.SessionManager.inMemory(temp.make("pi-run-texts-"));
    const text = (value: string) => ({ type: "text" as const, text: value });
    const toolCall = { type: "toolCall" as const, id: "t1", name: "read", arguments: {} };
    const user = (value: string) => ({ role: "user" as const, content: value, timestamp: 0 });
    const assistant = (content: unknown[]) =>
      ({ role: "assistant", content, stopReason: content.includes(toolCall) ? "toolUse" : "stop" }) as never;
    const toolResult = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [text("file")],
      isError: false,
      timestamp: 0,
    } as never;

    [
      user("task"),
      assistant([text("Status: done\nfirst run")]),
      user("wake"),
      assistant([text("Status: done\nreport"), toolCall]),
      toolResult,
      user("steered"),
      assistant([toolCall]),
      toolResult,
      assistant([text("  bye  ")]),
    ].forEach((message) => {
      session.appendMessage(message);
    });

    expect(finalRunTexts(session.getEntries())).toEqual(["Status: done\nreport", "bye"]);
  });

  it("starts a run at a displayed custom entry and ignores a hidden one", () => {
    const session = pi.SessionManager.inMemory(temp.make("pi-custom-runs-"));
    const text = (value: string) => ({ type: "text" as const, text: value });
    const assistant = (value: string) =>
      ({ role: "assistant", content: [text(value)], stopReason: "stop" }) as never;

    session.appendMessage({ role: "user", content: "task", timestamp: 0 });
    session.appendMessage(assistant("old answer"));
    session.appendCustomMessageEntry("req", "now", true);
    session.appendMessage(assistant("new answer"));

    expect(
      session.getEntries().map((entry) => [entry.type, "display" in entry ? entry.display : undefined]),
    ).toEqual([
      ["message", undefined],
      ["message", undefined],
      ["custom_message", true],
      ["message", undefined],
    ]);
    expect(finalRunTexts(session.getEntries())).toEqual(["new answer"]);
  });

  describe("custom messages in a session", () => {
    const offlineSession = async () => {
      const dir = temp.make("pi-custom-queue-");

      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: await pi.ModelRuntime.create(),
        model: offlineModel as never,
        resourceLoader: new pi.DefaultResourceLoader({
          cwd: dir,
          agentDir: dir,
          settingsManager: pi.SettingsManager.inMemory({}),
        }),
        settingsManager: pi.SettingsManager.inMemory({}),
        sessionManager: pi.SessionManager.inMemory(dir),
        tools: [],
      });

      return session;
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const fauxSession = async (responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      const dir = temp.make("pi-custom-faux-");

      vi.stubEnv("PI_CODING_AGENT_DIR", dir);
      writeFileSync(join(dir, "notes.txt"), "notes");

      const faux = fauxProvider();
      const modelRuntime = await pi.ModelRuntime.create();

      modelRuntime.registerNativeProvider(faux.provider);
      faux.setResponses(responses);

      const { session } = await pi.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime,
        model: faux.getModel() as never,
        resourceLoader: new pi.DefaultResourceLoader({
          cwd: dir,
          agentDir: dir,
          settingsManager: pi.SettingsManager.inMemory({}),
        }),
        settingsManager: pi.SettingsManager.inMemory({}),
        sessionManager: pi.SessionManager.inMemory(dir),
      });

      return session;
    };

    it("emits message_start with the type and the string content of a custom message steered into a streaming turn", async () => {
      const session = await fauxSession([
        fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxText("done")),
        fauxAssistantMessage(fauxText("done")),
      ]);

      const started: unknown[] = [];
      let steered: Promise<void> | undefined;

      session.subscribe((event) => {
        if (event.type === "tool_execution_start" && !steered) {
          steered = session.sendCustomMessage(
            { customType: "req", content: "x", display: true },
            { deliverAs: "steer", triggerTurn: true },
          );
        }

        if (event.type === "message_start" && event.message.role === "custom") {
          started.push([event.message.customType, event.message.content]);
        }
      });

      await session.prompt("read the notes");
      await steered;

      expect(started).toEqual([["req", "x"]]);

      session.dispose();
    });

    it("starts a run for a custom message sent with triggerTurn to an idle session, whatever deliverAs says", async () => {
      const session = await fauxSession([fauxAssistantMessage(fauxText("ok"))]);

      await session.sendCustomMessage(
        { customType: "req", content: "x", display: true },
        { deliverAs: "steer", triggerTurn: true },
      );

      const roles = session.sessionManager
        .getEntries()
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type));

      expect(roles).toContain("assistant");

      session.dispose();
    });

    it("emits message_start with the sent type and content, appends the entry and queues next-turn messages apart", async () => {
      const session = await offlineSession();
      const started: unknown[] = [];

      session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "custom") {
          started.push([event.message.customType, event.message.content]);
        }
      });

      await session.sendCustomMessage(
        { customType: "req", content: "now", display: true },
        { triggerTurn: false },
      );
      await session.sendCustomMessage(
        { customType: "later", content: "queued", display: true },
        { deliverAs: "nextTurn" },
      );

      expect(started).toEqual([["req", "now"]]);
      expect(
        session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(1);

      session.dispose();
    });

    it("drops the agent's queued custom messages on clearQueue and counts only text in pendingMessageCount", async () => {
      const session = await offlineSession();
      const custom = {
        role: "custom",
        customType: "req",
        content: "now",
        display: true,
        timestamp: 0,
      } as never;

      session.agent.steer(custom);

      expect(session.agent.hasQueuedMessages()).toBe(true);
      expect(session.pendingMessageCount).toBe(0);

      expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
      expect(session.agent.hasQueuedMessages()).toBe(false);

      session.dispose();
    });
  });

  it("records the first provider request once as the prompt record", () => {
    const { api, entries, fire } = fakeExtensionApi();

    createChildExtension(promptRecordEntry("test-ext"))(api as never);

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
        data: { providerPayload: { model: "x", n: 1 } },
      },
    ]);
  });

  describe("tool list filtering", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const sessionTools = async (tools: string[]) => {
      const dir = temp.make("pi-conformance-");

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
      const { names } = await sessionTools(childToolNames({ tools: ["read"], customNames: [] }, noMainTools));

      expect(names).toEqual([...LATE_MCP, "read"]);
    });

    it("keeps MCP tools registered after the start inactive for mcp: false", async () => {
      const tools = childToolNames({ tools: ["read"], customNames: [], mcp: false }, noMainTools);
      const { active } = await sessionTools(tools);

      expect(tools.some((name) => name.startsWith("mcp__"))).toBe(false);
      expect(active).toContain("read");
      expect(active.filter((name) => name.startsWith("mcp__"))).toEqual([]);
    });

    it("keeps the main session's tools and every MCP tool for tools: all", async () => {
      const { names } = await sessionTools(
        childToolNames({ tools: undefined, customNames: [] }, () => ["read", "web_fetch"]),
      );

      expect(names).toEqual([...LATE_MCP, "read", "web_fetch"]);
    });

    it("keeps no tool at all for tools: []", async () => {
      const { names, active } = await sessionTools(
        childToolNames({ tools: [], customNames: [] }, noMainTools),
      );

      expect(names).toEqual([]);
      expect(active).toEqual([]);
    });

    it("keeps a third-party extension's MCP tools registered but inactive for tools: [] with agent tools", async () => {
      const tools = childToolNames({ tools: [], customNames: ["web_fetch"] }, noMainTools);
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
      const dir = temp.make("pi-conformance-");
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

  describe("main session skills", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const skillFile = (dir: string, name: string, description: string) => {
      const path = join(dir, "skills", name, "SKILL.md");

      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`);

      return path;
    };

    it("reads each skill command's name without the skill: prefix, its description and its file", async () => {
      const dir = temp.make("pi-conformance-");
      const seen: pi.ExtensionAPI[] = [];
      const review = skillFile(dir, "review", "Reviews diffs for bugs");
      const docs = skillFile(dir, "docs", "Writes and fixes docs");

      vi.stubEnv("PI_CODING_AGENT_DIR", dir);

      const settingsManager = pi.SettingsManager.inMemory({});

      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        additionalSkillPaths: [review, docs],
        extensionFactories: [
          {
            name: "probe",
            factory: (api) => {
              seen.push(api);
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

      await session.bindExtensions({ mode: "print" });

      const files = seen[0] ? sessionSkillFiles(seen[0]) : [];

      session.dispose();

      expect(files.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: "docs", description: "Writes and fixes docs", scope: "user", path: docs },
        { name: "review", description: "Reviews diffs for bugs", scope: "user", path: review },
      ]);
    });
  });

  describe("skill inventory", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const skillAt = (dir: string, name: string) => {
      const path = join(dir, name, "SKILL.md");

      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(path, `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody of ${name}.\n`);

      return path;
    };

    const layout = () => {
      const home = temp.make("pi-conformance-home-");
      const agentDir = join(home, "agent");
      const cwd = temp.make("pi-conformance-project-");

      vi.stubEnv("HOME", home);
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

      return {
        agentDir,
        cwd,
        user: skillAt(join(agentDir, "skills"), "user-skill"),
        userAgents: skillAt(join(home, ".agents", "skills"), "user-agents-skill"),
        project: skillAt(join(cwd, ".pi", "skills"), "project-skill"),
        projectAgents: skillAt(join(cwd, ".agents", "skills"), "project-agents-skill"),
      };
    };

    const byName = (files: { name: string; path: string }[]) =>
      Object.fromEntries(files.map((file) => [file.name, file.path]));

    it("finds the project's .pi and .agents skills and the user's skills, none of them loaded by a session", async () => {
      const dirs = layout();
      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found).toEqual({
        "project-skill": dirs.project,
        "project-agents-skill": dirs.projectAgents,
        "user-skill": dirs.user,
        "user-agents-skill": dirs.userAgents,
      });
    });

    const scopes = (files: { name: string; scope: string }[]) =>
      Object.fromEntries(files.map((file) => [file.name, file.scope]));

    it("marks the project's .agents and .pi skills project and the agent dir's skills user", async () => {
      const dirs = layout();
      const found = scopes(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found).toEqual({
        "project-skill": "project",
        "project-agents-skill": "project",
        "user-skill": "user",
        "user-agents-skill": "user",
      });
    });

    it("gives settings entries and packages the scope of the settings file that names them", async () => {
      const dirs = layout();

      skillAt(join(dirs.cwd, "team-skills"), "team-skill");
      skillAt(join(dirs.cwd, "pkg", "skills"), "package-skill");
      skillAt(join(dirs.agentDir, "shared-skills"), "shared-skill");
      writeFileSync(
        join(dirs.cwd, ".pi", "settings.json"),
        JSON.stringify({ skills: ["../team-skills"], packages: ["../pkg"] }),
      );
      writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({ skills: ["shared-skills"] }));

      const found = scopes(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found).toMatchObject({
        "team-skill": "project",
        "package-skill": "project",
        "shared-skill": "user",
      });
    });

    it("leaves out the project's skills when the project is not trusted", async () => {
      const dirs = layout();
      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: false }),
      );

      expect(found).toEqual({ "user-skill": dirs.user, "user-agents-skill": dirs.userAgents });
    });

    it("follows the skills entries of the user and project settings files, each from its own dir", async () => {
      const dirs = layout();
      const extra = skillAt(join(dirs.cwd, "team-skills"), "team-skill");

      writeFileSync(join(dirs.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["../team-skills"] }));

      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found["team-skill"]).toBe(extra);
    });

    it("finds the skills of a local package named in the project settings", async () => {
      const dirs = layout();
      const packaged = skillAt(join(dirs.cwd, "pkg", "skills"), "package-skill");

      writeFileSync(join(dirs.cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["../pkg"] }));

      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found["package-skill"]).toBe(packaged);
    });

    it("ignores the ! and - exclusions of both settings files, which still hide the skills from a main session", async () => {
      const dirs = layout();
      const team = skillAt(join(dirs.cwd, "team-skills"), "team-skill");
      const excluded = (extra: string[]) => JSON.stringify({ skills: ["!**/.agents/skills/**", ...extra] });

      writeFileSync(
        join(dirs.agentDir, "settings.json"),
        excluded([`-${join(dirs.agentDir, "skills", "user-skill")}`]),
      );
      writeFileSync(
        join(dirs.cwd, ".pi", "settings.json"),
        excluded([
          "../team-skills",
          `+${join(dirs.cwd, "team-skills", "team-skill")}`,
          "-skills/project-skill",
        ]),
      );

      const mainLoader = new pi.DefaultResourceLoader({
        cwd: dirs.cwd,
        agentDir: dirs.agentDir,
        settingsManager: pi.SettingsManager.create(dirs.cwd, dirs.agentDir, { projectTrusted: true }),
        noExtensions: true,
      });

      await mainLoader.reload();

      const main = mainLoader.getSkills().skills.map((skill) => skill.name);
      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(main).toEqual(["team-skill"]);
      expect(found).toEqual({
        "project-skill": dirs.project,
        "project-agents-skill": dirs.projectAgents,
        "user-skill": dirs.user,
        "user-agents-skill": dirs.userAgents,
        "team-skill": team,
      });
    });

    it("skips missing packages instead of installing them, and writes nothing", async () => {
      const dirs = layout();
      const settings = JSON.stringify({
        packages: ["npm:pi-conformance-missing-package", "git:example.invalid/a/b"],
      });

      writeFileSync(join(dirs.cwd, ".pi", "settings.json"), settings);
      writeFileSync(join(dirs.agentDir, "settings.json"), settings);

      const before = [
        readdirSync(dirs.cwd, { recursive: true }),
        readdirSync(dirs.agentDir, { recursive: true }),
      ];
      const found = byName(
        await discoverSkills({ cwd: dirs.cwd, agentDir: dirs.agentDir, projectTrusted: true }),
      );

      expect(found["project-skill"]).toBe(dirs.project);
      expect([
        readdirSync(dirs.cwd, { recursive: true }),
        readdirSync(dirs.agentDir, { recursive: true }),
      ]).toEqual(before);
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
      const added = childToolNames({ tools: ["read"], customNames: [] }, noMainTools).filter(
        (name) => name !== "read",
      );
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

  describe("transcript rows", () => {
    const fakeTui = { requestRender: () => {} } as never;

    const plain = (component: { render(width: number): string[] }, width = 80) =>
      component.render(width).map((line) => tui.stripTerminalSequences(line).trimEnd());

    const textResult = (text: string, details?: unknown) =>
      ({ content: [{ type: "text", text }], details, isError: false }) as never;

    const renderContext = (patch: Partial<PiToolRenderContext> = {}) =>
      piRenderContext({ expanded: true, outputPad: 0, ...patch });

    it("names the same built-in tools as pi", async () => {
      const tools = await import(
        new URL("core/tools/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
      );

      expect([...BUILTIN_TOOLS].toSorted()).toEqual([...tools.allToolNames].toSorted());
    });

    it("hands renderers the context fields the rows read, and puts one blank line before a self-drawn tool", () => {
      initPiRenderTheme();

      const contexts: Record<string, unknown>[] = [];
      const capture = (_value: unknown, ...rest: unknown[]) => {
        contexts.push(rest.at(-1) as Record<string, unknown>);
        return new tui.Text("row", 0, 0);
      };
      const component = new pi.ToolExecutionComponent(
        "probe",
        "call-1",
        { a: 1 },
        { outputPad: 1 },
        { renderShell: "self", renderCall: capture, renderResult: capture } as never,
        fakeTui,
        "/repo",
      );

      component.updateResult(textResult("out"));

      const fields = ["args", "argsComplete", "executionStarted", "isPartial", "isError", "expanded", "cwd"];

      expect(plain(component)).toEqual(["", "row", "row"]);
      expect(contexts.length).toBeGreaterThan(0);
      contexts.forEach((context) => {
        expect(fields.filter((field) => !(field in context))).toEqual([]);
        expect(typeof context.outputPad).toBe("number");
        expect(typeof context.state).toBe("object");
        expect("lastComponent" in context).toBe(true);
      });
    });

    it("draws the call before the result in one update and hands both the recorded duration", () => {
      initPiRenderTheme();

      const order: string[] = [];
      const durations: unknown[] = [];
      const capture =
        (name: string) =>
        (_value: unknown, ...rest: unknown[]) => {
          order.push(name);
          durations.push((rest.at(-1) as { durationMs?: number }).durationMs);
          return new tui.Text(name, 0, 0);
        };
      const component = new pi.ToolExecutionComponent(
        "probe",
        "call-1",
        {},
        { outputPad: 1 },
        { renderShell: "self", renderCall: capture("call"), renderResult: capture("result") } as never,
        fakeTui,
        "/repo",
      );

      order.length = 0;
      durations.length = 0;
      component.updateResult({ ...(textResult("out") as object), durationMs: 4_200 } as never);

      expect(order).toEqual(["call", "result"]);
      expect(durations).toEqual([4_200, 4_200]);
    });

    it("shows the edit diff from the result details when the call was never drawn", () => {
      initPiRenderTheme();

      const edit = pi.createEditToolDefinition("/repo") as unknown as pi.ToolDefinition;
      const lines = plain(
        edit.renderResult?.(
          textResult("ok", { diff: "-1 old line\n+1 new line" }),
          { expanded: false, isPartial: false },
          {} as never,
          renderContext({ args: { path: "a.ts" }, expanded: false }),
        ) as never,
      );

      expect(lines.some((line) => line.includes("old line"))).toBe(true);
      expect(lines.some((line) => line.includes("new line"))).toBe(true);
    });

    it("returns an edit diff of numbered added, removed and context lines the rows parse", async () => {
      const dir = temp.make("pi-conformance-");
      const lines = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`);

      writeFileSync(join(dir, "a.txt"), `${lines.join("\n")}\n`);

      const edit = pi.createEditToolDefinition(dir) as unknown as pi.ToolDefinition;
      const result = await edit.execute(
        "call-1",
        {
          path: "a.txt",
          edits: [
            { oldText: "line 2\n", newText: "line 2 changed\n" },
            { oldText: "line 18\n", newText: "line 18 changed\n" },
          ],
        } as never,
        undefined,
        undefined,
        undefined as never,
      );
      const diff = (result.details as { diff: string }).diff;

      expect(diff.split("\n")).toEqual(
        expect.arrayContaining(["- 2 line 2", "+ 2 line 2 changed", "    ..."]),
      );
      expect(
        diff.split("\n").filter((line) => !/^[+\- ] *\d+ /.test(line) && !/^ +\.\.\.$/.test(line)),
      ).toEqual([]);
      expect(pi.generateDiffString("a\n", "b\n").diff).toBe("-1 a\n+1 b");
    });

    it("has the theme colours, background style and colour mixing the diff and user row backgrounds use", async () => {
      const themes = await import(
        new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
          .href
      );

      pi.initTheme("dark", false);

      const theme: pi.Theme = themes.theme;
      const colors = [
        "toolSuccessBg",
        "toolErrorBg",
        "toolDiffAdded",
        "toolDiffRemoved",
        "userMessageBg",
        "customMessageLabel",
        "customMessageText",
      ] as const;
      const mixed = tui.mixColors(theme.colors.toolSuccessBg, theme.colors.toolDiffAdded, 0.4);

      expect(colors.filter((name) => theme.colors[name] === undefined)).toEqual([]);
      expect(theme.style("x", { bg: "toolSuccessBg" })).toContain("\x1b[48;");
      expect(theme.style("x", { bg: mixed })).toContain("\x1b[48;");
      expect(tui.stripTerminalSequences(theme.style("x", { bg: mixed }))).toBe("x");
      expect(stripVTControlCharacters(theme.fg("customMessageLabel", "x"))).toBe("x");
    });

    it("closes a foreground with its own reset only, so a surrounding background stays", async () => {
      const themes = await import(
        new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
          .href
      );

      pi.initTheme("dark", false);

      const theme: pi.Theme = themes.theme;
      const painted = (["success", "error", "dim", "text"] as const).map((token) => theme.fg(token, "x"));

      painted.forEach((text) => {
        expect(text.endsWith("\x1b[39m")).toBe(true);
        expect(text).not.toContain("\x1b[0m");
        expect(text).not.toContain("\x1b[49m");
      });
    });

    it("gives concrete colours for tokens set to the terminal default", async () => {
      const themes = await import(
        new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
          .href
      );
      const dark = JSON.parse(
        readFileSync(
          new URL(
            "modes/interactive/theme/dark.json",
            import.meta.resolve("@earendil-works/pi-coding-agent"),
          ),
          "utf8",
        ),
      );
      const dir = temp.make("pi-conformance-");
      const path = join(dir, "blank.json");

      writeFileSync(
        path,
        JSON.stringify({
          ...dark,
          name: "blank",
          colors: { ...dark.colors, toolSuccessBg: "", toolDiffAdded: "" },
        }),
      );

      const theme: pi.Theme = themes.loadThemeFromPath(path, "truecolor");

      expect(theme.colors.toolSuccessBg).toBeDefined();
      expect(theme.colors.toolDiffAdded).toBeDefined();
      expect(() => tui.mixColors(theme.colors.toolSuccessBg, theme.colors.toolDiffAdded, 0.4)).not.toThrow();
    });

    it("shows the whole read and bash output when expanded", () => {
      initPiRenderTheme();

      const output = Array.from({ length: 20 }, (_value, index) => `out ${index + 1}`).join("\n");
      const render = (definition: pi.ToolDefinition, args: unknown) =>
        plain(
          definition.renderResult?.(
            textResult(output),
            { expanded: true, isPartial: false },
            {
              fg: (_token: string, text: string) => text,
              bold: (text: string) => text,
            } as never,
            renderContext({ args }),
          ) as never,
        );

      expect(render(pi.createReadToolDefinition("/repo") as never, { path: "a.txt" })).toContain("out 20");
      expect(render(pi.createBashToolDefinition("/repo") as never, { command: "ls" })).toContain("out 20");
      expect(render(pi.createBashToolDefinition("/repo") as never, { command: "ls" })).toContain("out 1");
    });

    it("marks pi's own tools, codemode among them, with the builtin source and a third-party tool without it", async () => {
      vi.stubEnv("PI_CODING_AGENT_DIR", temp.make("pi-conformance-"));

      const dir = temp.make("pi-conformance-");
      const seen: { api?: pi.ExtensionAPI } = {};
      const settingsManager = pi.SettingsManager.inMemory({});
      const loader = new pi.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: [
          {
            name: "probe",
            factory: (api) => {
              seen.api = api;
              api.registerTool({
                ...namedTool("probe_tool"),
                renderCall: () => new tui.Text("own", 0, 0),
              } as never);
            },
          },
          { name: "codemode", factory: pi.createCodemodeExtension(), replaceable: true, builtin: true },
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

      const api = seen.api as pi.ExtensionAPI;
      const shipped = ["read", "codemode", "probe_tool"].map((name) => piShipped(api, name));

      session.dispose();
      vi.unstubAllEnvs();

      expect(shipped).toEqual([true, true, false]);
    });

    it("pi's codemode renderer drops the `Script … Wall time … Output:` header", () => {
      initPiRenderTheme();

      const captured = capturePiRenderers({ codemode: pi.createCodemodeExtension });
      const header = { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
      const lines = plain(
        captured.codemode?.renderResult?.(
          {
            content: [header, { type: "text", text: "out 1" }],
            details: { calls: [] },
            isError: false,
          } as never,
          { expanded: true, isPartial: false },
          { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
          renderContext({ args: { code: "return 1" } }),
        ) as never,
      );

      expect(lines).toContain("out 1");
      expect(lines.some((line) => line.includes("Wall time"))).toBe(false);
    });
  });

  describe("messages and the thinking label", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "answer" },
      ],
      stopReason: "stop",
      timestamp: 0,
    } as never;

    const ESC = String.fromCharCode(27);

    const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

    const italicAt = (line: string, index: number) =>
      Array.from(line.slice(0, index).matchAll(SGR)).reduce((italic, match) => {
        const codes = (match[1] ?? "").split(";");

        if (codes.includes("3")) {
          return true;
        }

        return codes.includes("23") || codes.includes("0") || codes.includes("") ? false : italic;
      }, false);

    it("emits an entry appended in an extension's message_end before that message_end reaches session listeners", async () => {
      const dir = temp.make("pi-conformance-");
      const order: string[] = [];
      let fileOrder: string[] = [];

      writeFileSync(join(dir, "notes.txt"), "one\n");

      try {
        vi.stubEnv("PI_CODING_AGENT_DIR", dir);

        const settingsManager = pi.SettingsManager.inMemory({});

        const loader = new pi.DefaultResourceLoader({
          cwd: dir,
          agentDir: dir,
          settingsManager,
          extensionFactories: [
            {
              name: "marker",
              factory: (api) => {
                api.on("message_end", (event) => {
                  if (event.message.role !== "assistant") {
                    return;
                  }

                  if (event.message.content.some((part) => part.type === "toolCall")) {
                    return;
                  }

                  api.appendEntry("conformance:mark", {});
                });
              },
            },
          ],
        });

        await loader.reload();

        const faux = fauxProvider();
        const modelRuntime = await pi.ModelRuntime.create();

        modelRuntime.registerNativeProvider(faux.provider);
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxText("done")),
        ]);

        const { session } = await pi.createAgentSession({
          cwd: dir,
          agentDir: dir,
          modelRuntime,
          model: faux.getModel() as never,
          resourceLoader: loader,
          settingsManager,
          sessionManager: pi.SessionManager.inMemory(dir),
        });

        await session.bindExtensions({ mode: "print", uiContext: {} as unknown as pi.ExtensionUIContext });

        session.subscribe((event) => {
          const seen = event as {
            type: string;
            entry?: { customType?: string };
            message?: { role?: string };
          };

          if (seen.type === "message_end" && seen.message?.role === "assistant") {
            order.push("assistant message_end");
          }

          if (seen.type === "entry_appended" && seen.entry?.customType === "conformance:mark") {
            order.push("mark");
          }
        });

        await session.prompt("read the notes");
        fileOrder = session.sessionManager.getEntries().map((entry) => {
          const message = entry.type === "message" ? entry.message.role : undefined;

          return entry.type === "custom" ? entry.customType : (message ?? entry.type);
        });
        session.dispose();
      } finally {
        vi.unstubAllEnvs();
      }

      expect(order).toEqual(["assistant message_end", "mark", "assistant message_end"]);
      expect(fileOrder.slice(-3)).toEqual(["toolResult", "conformance:mark", "assistant"]);
    });

    it("draws the user message between prompt marks the transcript pane takes off", () => {
      initPiRenderTheme();

      const lines = new pi.UserMessageComponent("hello", pi.getMarkdownTheme()).render(30);

      expect(lines[0]?.startsWith("\x1b]133;A\x07")).toBe(true);
      expect(lines.at(-1)?.startsWith("\x1b]133;B\x07\x1b]133;C\x07")).toBe(true);
      expect(
        lines.map((line) => line.replace(OSC133_ZONE_PREFIX, "")).some((line) => line.includes(`${ESC}]`)),
      ).toBe(false);
    });

    it("routes clicks in a container by the child layout of the last render", () => {
      expect(typeof tui.Container.prototype.handleMouse).toBe("function");
    });

    it("takes the hidden thinking label as the fourth constructor argument", () => {
      initPiRenderTheme();

      const component = new pi.AssistantMessageComponent(message, true, pi.getMarkdownTheme(), "Thinking");

      expect(component.render(40).some((line) => tui.stripTerminalSequences(line).includes("Thinking"))).toBe(
        true,
      );
    });

    it("draws the composed hint dim and not italic after the italic label", async () => {
      initPiRenderTheme();

      const themeUrl = new URL(
        "modes/interactive/theme/theme.js",
        import.meta.resolve("@earendil-works/pi-coding-agent"),
      );
      const { default: chalk } = (await import(
        pathToFileURL(createRequire(themeUrl).resolve("chalk")).href
      )) as { default: { level: number } };
      const level = chalk.level;
      const { theme } = (await import(themeUrl.href)) as { theme: pi.Theme };

      chalk.level = 1;

      try {
        const label = composeLabel(theme, "Thinking", "(ctrl+t to expand)");
        const line =
          new pi.AssistantMessageComponent(message, true, pi.getMarkdownTheme(), label)
            .render(60)
            .find((text) => text.includes("(ctrl+t to expand)")) ?? "";
        const hint = line.indexOf("(ctrl+t to expand)");

        expect(tui.stripTerminalSequences(line).trim()).toBe("Thinking (ctrl+t to expand)");
        expect(italicAt(line, line.indexOf("Thinking") + 1)).toBe(true);
        expect(line.slice(0, hint).endsWith(`${ESC}[0m${theme.getFgAnsi("dim")}`)).toBe(true);
        expect(italicAt(line, hint)).toBe(false);
      } finally {
        chalk.level = level;
      }
    });
  });
});

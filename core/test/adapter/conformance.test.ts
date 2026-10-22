import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THINKING_LEVELS } from "../../adapter/contract.ts";
import { finalRunTexts } from "../../adapter/messages.ts";
import { mcpBuiltinLoaded, skillFiles } from "../../adapter/pi-adapter.ts";
import { childSettings, childToolNames, createChildExtension } from "../../adapter/pi-child.ts";
import { availableModels } from "../../adapter/pi-models.ts";
import { ASSISTANT_DELTA_TYPES } from "../../adapter/pi-phase.ts";
import { discoverSkills } from "../../adapter/pi-skills.ts";
import { promptRecordEntry } from "../../adapter/session-file.ts";

const ADAPTER_PI_MAJOR = 1;

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
      "CustomEditor",
    ];

    const requiredTui = [
      "Container",
      "Editor",
      "isKeyRelease",
      "Key",
      "matchesKey",
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
    const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));
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

      const api = ["registerEntryRenderer", "getSettings", "getAllTools", "getActiveTools", "getCommands"];
      const ui = ["custom", "getEditorComponent", "setEditorComponent", "setWidget", "onTerminalInput"];
      const probe = seen.api?.getAllTools().find((tool) => tool.name === "probe_tool");

      expect(api.filter((name) => typeof Reflect.get(seen.api ?? {}, name) !== "function")).toEqual([]);
      expect(ui.filter((name) => typeof Reflect.get(seen.ui ?? {}, name) !== "function")).toEqual([]);
      expect(typeof seen.api?.getSettings()).toBe("object");
      expect(typeof probe?.sourceInfo.path).toBe("string");
      expect(probe?.exposure).toBe("model-only");

      session.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
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

    createChildExtension("a1", "acme/x", promptRecordEntry("test-ext"))(api as never);

    expect(fire("session_before_compact", { reason: "threshold" })).toEqual([{ cancel: true }]);
    expect(fire("session_before_compact", { reason: "overflow" })).toEqual([{ cancel: true }]);
  });

  it("reads the assistant texts of a child's final run from pi's session entries", () => {
    const session = pi.SessionManager.inMemory(mkdtempSync(join(tmpdir(), "pi-run-texts-")));
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
      const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));
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

      const files = seen[0] ? skillFiles(seen[0]) : [];

      session.dispose();

      expect(files.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: "docs", description: "Writes and fixes docs", path: docs },
        { name: "review", description: "Reviews diffs for bugs", path: review },
      ]);
    });
  });

  describe("skill inventory", () => {
    const made: string[] = [];

    afterEach(() => {
      vi.unstubAllEnvs();
      made.splice(0).forEach((dir) => {
        rmSync(dir, { recursive: true, force: true });
      });
    });

    const skillAt = (dir: string, name: string) => {
      const path = join(dir, name, "SKILL.md");

      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(path, `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody of ${name}.\n`);

      return path;
    };

    const layout = () => {
      const home = mkdtempSync(join(tmpdir(), "pi-conformance-home-"));
      const agentDir = join(home, "agent");
      const cwd = mkdtempSync(join(tmpdir(), "pi-conformance-project-"));

      made.push(home, cwd);

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
});

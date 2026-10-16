import { isAbsolute, resolve, sep } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { settleWithin } from "../manager/settle.ts";
import type {
  AgentRuntime,
  ChildEvent,
  ChildSession,
  MessageDelivery,
  SpawnSpec,
  StopReason,
  UsageTotals,
} from "./contract.ts";
import { messageText, toolCallCount } from "./messages.ts";
import { resolutionFailure, resolveFromCatalog } from "./pi-models.ts";
import { childScope } from "./pi-scope.ts";
import { applyPromptSections } from "./pi-sections.ts";
import { toPiTool } from "./pi-tools.ts";
import { formatRoutedMessage } from "./route.ts";
import { promptRecordEntry, readSessionFile } from "./session-file.ts";
import { contextOf, sumUsage } from "./usage.ts";

const SHUTDOWN_TIMEOUT_MS = 2_000;

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

export type SkillFile = { name: string; path: string };

export type ParentSource = {
  ctx(): ExtensionContext;
  settings(): Settings;
  thinking(): string;
  skillFiles(): SkillFile[];
  activeTools(): { name: string; path: string }[];
  mcpDisabled(): boolean;
};

export const childSettings = (snapshot: Settings, reserveTokens: number): Settings => ({
  ...snapshot,
  compaction: { ...snapshot.compaction, enabled: false, reserveTokens },
  cacheWarming: "off",
});

export const createChildExtension =
  (agentId: string, modelLabel: string, recordEntry: string): ExtensionFactory =>
  (pi) => {
    let recorded = false;
    let skills: { name: string; description: string }[] = [];
    let guidelines: string[] = [];

    pi.on("session_before_compact", () => ({ cancel: true }));

    pi.on("before_agent_start", (event) => {
      applyPromptSections(event.systemPromptOptions);

      skills = event.systemPromptOptions.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      }));

      guidelines = [
        ...event.systemPromptOptions.promptGuidelines,
        ...Object.values(event.systemPromptOptions.toolGuidelines).flat(),
      ];
    });

    pi.on("before_provider_request", (event) => {
      if (recorded) {
        return;
      }

      recorded = true;

      pi.appendEntry(recordEntry, {
        agentId,
        model: modelLabel,
        skills,
        guidelines,
        providerPayload: event.payload,
      });
    });
  };

const MCP_PREFIX = "mcp__";

const MCP_DISCOVERY_TOOLS = ["codemode", "tool_search"];

const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

const MCP_TOOLS = [...MCP_DISCOVERY_TOOLS, `${MCP_PREFIX}*`, ...MCP_RESOURCE_TOOLS];

const isMcpTool = (name: string) =>
  name.startsWith(MCP_PREFIX) || MCP_DISCOVERY_TOOLS.includes(name) || MCP_RESOURCE_TOOLS.includes(name);

const wantsMcp = (tools: readonly string[] | undefined) => tools === undefined || tools.length > 0;

export const childToolNames = (
  tools: string[] | undefined,
  customNames: string[],
  mainTools: () => string[],
) => {
  const mcp = wantsMcp(tools) ? MCP_TOOLS : [];

  return Array.from(new Set([...(tools ?? mainTools()), ...mcp, ...customNames]));
};

const mcpExtensions = (tools: readonly string[] | undefined, mcpDisabled: boolean): InlineExtension[] => {
  if (!wantsMcp(tools)) {
    return [];
  }

  const discovery: InlineExtension[] = [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
  ];

  return mcpDisabled
    ? discovery
    : [...discovery, { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true }];
};

const isExcluded = (exclude: readonly string[], path: string) =>
  isAbsolute(path) && exclude.some((dir) => resolve(path).startsWith(`${resolve(dir)}${sep}`));

const pickSkillFiles = (available: SkillFile[], wanted: readonly string[] | undefined) =>
  available.filter((skill) => !wanted || wanted.includes(skill.name)).map((skill) => skill.path);

export const createPiRuntime = (
  parent: ParentSource,
  options: { namespace: string; exclude: readonly string[] },
): AgentRuntime => {
  const recordEntry = promptRecordEntry(options.namespace);
  const defaultProvider = () => (parent.settings() as { defaultProvider?: string }).defaultProvider;

  const mainTools = () =>
    parent
      .activeTools()
      .filter((tool) => !isMcpTool(tool.name) && !isExcluded(options.exclude, tool.path))
      .map((tool) => tool.name);

  let modelRuntime: Promise<ModelRuntime> | undefined;

  const sharedModelRuntime = () => {
    modelRuntime ??= ModelRuntime.create();

    return modelRuntime;
  };

  const spawn = async (spec: SpawnSpec): Promise<ChildSession> => {
    const ctx = parent.ctx();
    const { resolution, model } = resolveFromCatalog(ctx, spec.model, defaultProvider());

    if (resolution.kind !== "resolved" || !model) {
      throw new Error(resolutionFailure(resolution));
    }

    const modelLabel = `${model.provider}/${model.id}`;
    const listeners = new Set<(event: ChildEvent) => void>();
    let running = false;
    let disposed = false;

    const emit = (event: ChildEvent) => {
      if (event.type === "settled") {
        running = false;
      }

      listeners.forEach((listener) => {
        listener(event);
      });
    };

    const settingsManager = SettingsManager.inMemory(childSettings(parent.settings(), spec.reserveTokens), {
      projectTrusted: ctx.isProjectTrusted(),
    });

    const agentDir = getAgentDir();
    const wantedSkills = spec.skills ? new Set(spec.skills) : undefined;

    const loader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      additionalSkillPaths: pickSkillFiles(parent.skillFiles(), spec.skills),
      appendSystemPromptOverride: (base) => [...base, ...spec.promptAppend],
      skillsOverride: wantedSkills
        ? (current) => ({
            skills: current.skills.filter((skill) => wantedSkills.has(skill.name)),
            diagnostics: current.diagnostics,
          })
        : undefined,
      extensionsOverride: (result) => ({
        ...result,
        extensions: result.extensions.filter(
          (extension) => !isExcluded(options.exclude, extension.resolvedPath),
        ),
      }),
      extensionFactories: [
        {
          name: `${options.namespace}-child`,
          hidden: true,
          factory: createChildExtension(spec.id, modelLabel, recordEntry),
        },
        ...mcpExtensions(spec.tools, parent.mcpDisabled()),
      ],
    });

    const scope = { agentId: spec.id };

    await childScope.run(scope, () => loader.reload());

    const sessionManager = SessionManager.create(spec.cwd, spec.sessionDir, {
      parentSession: spec.parentSessionFile,
    });

    const { session } = await childScope.run(scope, async () =>
      createAgentSession({
        cwd: spec.cwd,
        agentDir,
        modelRuntime: await sharedModelRuntime(),
        model,
        thinkingLevel: spec.thinking as never,
        resourceLoader: loader,
        settingsManager,
        sessionManager,
        tools: childToolNames(
          spec.tools,
          spec.customTools.map((tool) => tool.name),
          mainTools,
        ),
        customTools: spec.customTools.map((tool) => toPiTool(tool)),
      }),
    );

    const dispose = async () => {
      disposed = true;

      await settleWithin(
        session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        SHUTDOWN_TIMEOUT_MS,
      );

      session.dispose();
      listeners.clear();
    };

    try {
      await childScope.run(scope, () => session.bindExtensions({ mode: "print" }));
    } catch (error) {
      await dispose();
      throw error;
    }

    session.subscribe((event) => {
      if (event.type === "turn_end") {
        emit({ type: "turn_end", context: contextOf(session) });
        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as { content: unknown; stopReason: StopReason; errorMessage?: string };

        emit({
          type: "assistant_message",
          text: messageText(message.content),
          stopReason: message.stopReason,
          toolCalls: toolCallCount(message.content),
          errorMessage: message.errorMessage,
        });

        return;
      }

      if (event.type === "tool_execution_start" && !event.parentToolCallId) {
        emit({ type: "tool_start", toolName: event.toolName });
        return;
      }

      if (event.type === "agent_settled") {
        if (!event.aborted && !disposed && session.pendingMessageCount > 0) {
          const { steering, followUp } = session.clearQueue();

          prompt([...steering, ...followUp].join("\n\n"));
          return;
        }

        emit({ type: "settled", aborted: event.aborted });
      }
    });

    const failStart = (error: unknown) => {
      if (!running) {
        return;
      }

      emit({
        type: "assistant_message",
        text: "",
        stopReason: "error",
        toolCalls: 0,
        errorMessage: String(error),
      });
      emit({ type: "settled", aborted: false });
    };

    const prompt = (text: string) => {
      running = true;
      session.prompt(text, { expandPromptTemplates: false, source: "extension" }).catch(failStart);
    };

    const deliver = async (text: string, delivery: MessageDelivery) => {
      if (disposed) {
        return;
      }

      if (!running && !session.isStreaming) {
        prompt(text);
        return;
      }

      if (delivery === "steer") {
        await session.steer(text, undefined, { source: "extension" });
        return;
      }

      await session.followUp(text, undefined, { source: "extension" });
    };

    return {
      id: spec.id,
      get sessionFile() {
        return session.sessionFile;
      },
      start: prompt,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      send: (message, delivery) => deliver(formatRoutedMessage(message), delivery),
      wake: (text) => deliver(text, "followUp"),
      abort: () => session.abort(),
      dispose,
      ownUsage: (): UsageTotals => sumUsage(session.sessionManager.getEntries()),
      lastText: () => session.getLastAssistantText() ?? "",
    };
  };

  return {
    spawn,
    readSession: (file) => readSessionFile(file, recordEntry),
    resolveModel: (request) => resolveFromCatalog(parent.ctx(), request, defaultProvider()).resolution,
    defaultThinking: () => parent.thinking(),
    skillNames: () => parent.skillFiles().map((skill) => skill.name),
  };
};

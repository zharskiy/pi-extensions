import { isAbsolute, resolve, sep } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  AnyToolSpec,
  ChildEvent,
  ChildPrompts,
  ChildSession,
  ContextSnapshot,
  MessageDelivery,
  ModelResolution,
  SpawnSpec,
  StopReason,
  UsageTotals,
} from "./contract.ts";
import { resolutionFailure, resolveFromCatalog } from "./pi-models.ts";
import { childScope } from "./pi-scope.ts";
import { toPiTool } from "./pi-tools.ts";
import { formatRoutedMessage } from "./route.ts";
import { promptRecordEntry, readSessionFile } from "./session-file.ts";
import { sumOwnUsage } from "./usage.ts";

const SHUTDOWN_TIMEOUT_MS = 2_000;

const timeout = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

export type ParentSource = {
  ctx(): ExtensionContext | undefined;
  settings(): Settings;
  thinking(): string;
};

export type ChildOptions = {
  namespace: string;
  exclude: readonly string[];
};

const toolCallCount = (content: unknown) =>
  Array.isArray(content) ? content.filter((part) => part?.type === "toolCall").length : 0;

const textParts = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
};

const snapshotContext = (session: AgentSession): ContextSnapshot => {
  const usage = session.getContextUsage();
  const window = usage?.contextWindow ?? session.model?.contextWindow ?? 0;

  return { tokens: usage?.tokens ?? null, window, percent: usage?.percent ?? null };
};

export const childSettings = (snapshot: Settings, reserveTokens: number): Settings => ({
  ...snapshot,
  compaction: { ...snapshot.compaction, enabled: false, reserveTokens },
  cacheWarming: "off",
});

export const createChildExtension =
  (
    agentId: string,
    emit: (event: ChildEvent) => void,
    modelLabel: string,
    recordEntry: string,
  ): ExtensionFactory =>
  (pi) => {
    let recorded = false;
    let skills: { name: string; description: string }[] = [];
    let guidelines: string[] = [];

    pi.on("session_before_compact", () => {
      emit({ type: "compaction_blocked" });

      return { cancel: true };
    });

    pi.on("before_agent_start", (event) => {
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

const silentUi = {
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined as never,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "UI not available" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

export const childUiContext = (theme: Theme, prompts: ChildPrompts | undefined): ExtensionUIContext => ({
  ...silentUi,
  theme,
  select: (title, options) => prompts?.select(title, options) ?? Promise.resolve(undefined),
  confirm: (title, message) => prompts?.confirm(title, message) ?? Promise.resolve(false),
  input: (title, placeholder) => prompts?.input(title, placeholder) ?? Promise.resolve(undefined),
  notify: (message, type = "info") => prompts?.notify(message, type),
});

const isExcluded = (exclude: readonly string[], path: string) =>
  isAbsolute(path) && exclude.some((dir) => resolve(path).startsWith(`${resolve(dir)}${sep}`));

export const createPiRuntime = (parent: ParentSource, options: ChildOptions): AgentRuntime => {
  const recordEntry = promptRecordEntry(options.namespace);
  const defaultProvider = () => (parent.settings() as { defaultProvider?: string }).defaultProvider;

  let modelRuntime: Promise<ModelRuntime> | undefined;

  const sharedModelRuntime = () => {
    modelRuntime ??= ModelRuntime.create();

    return modelRuntime;
  };

  const spawn = async (spec: SpawnSpec): Promise<ChildSession> => {
    const ctx = parent.ctx();

    if (!ctx) {
      throw new Error("no active pi session to spawn from");
    }

    const { resolution, model } = resolveFromCatalog(ctx, spec.model, defaultProvider());

    if (resolution.kind !== "resolved" || !model) {
      throw new Error(resolutionFailure(resolution));
    }

    const modelLabel = `${model.provider}/${model.id}`;
    const listeners = new Set<(event: ChildEvent) => void>();
    let settled = false;

    const emit = (event: ChildEvent) => {
      if (event.type === "settled") {
        settled = true;
      }

      listeners.forEach((listener) => {
        listener(event);
      });
    };

    const snapshot = parent.settings();
    const projectTrusted = ctx.isProjectTrusted();

    const settingsManager = SettingsManager.inMemory(childSettings(snapshot, spec.reserveTokens), {
      projectTrusted,
    });

    const agentDir = getAgentDir();
    const wantedSkills = spec.skills ? new Set(spec.skills) : undefined;

    const loader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir,
      settingsManager,
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
          factory: createChildExtension(spec.id, emit, modelLabel, recordEntry),
        },
      ],
    });

    const scope = { agentId: spec.id };

    await childScope.run(scope, () => loader.reload());

    const sessionManager = SessionManager.create(spec.cwd, spec.sessionDir, {
      parentSession: spec.parentSessionFile,
    });

    const thinking = (spec.thinking ?? parent.thinking()) as never;
    const customTools: AnyToolSpec[] = spec.customTools ?? [];

    const { session } = await childScope.run(scope, async () =>
      createAgentSession({
        cwd: spec.cwd,
        agentDir,
        modelRuntime: await sharedModelRuntime(),
        model,
        thinkingLevel: thinking,
        resourceLoader: loader,
        settingsManager,
        sessionManager,
        tools: spec.tools ? [...spec.tools, ...customTools.map((tool) => tool.name)] : undefined,
        customTools: customTools.map((tool) => toPiTool(tool)),
      }),
    );

    await childScope.run(scope, () =>
      session.bindExtensions({ mode: "print", uiContext: childUiContext(ctx.ui.theme, spec.prompts) }),
    );

    session.subscribe((event) => {
      if (event.type === "turn_start") {
        emit({ type: "turn_start" });
        return;
      }

      if (event.type === "turn_end") {
        emit({ type: "turn_end", context: snapshotContext(session) });
        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as { content: unknown; stopReason: StopReason; errorMessage?: string };

        emit({
          type: "assistant_message",
          text: textParts(message.content),
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

      if (event.type === "tool_execution_end" && !event.parentToolCallId) {
        emit({ type: "tool_end", toolName: event.toolName, isError: event.isError });
        return;
      }

      if (event.type === "agent_settled") {
        emit({ type: "settled", aborted: event.aborted });
      }
    });

    const failStart = (error: unknown) => {
      if (settled) {
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

    const deliver = async (text: string, delivery: MessageDelivery) => {
      if (!session.isStreaming) {
        session.prompt(text, { expandPromptTemplates: false, source: "extension" }).catch(failStart);
        return;
      }

      if (delivery === "steer") {
        await session.steer(text, undefined, { source: "extension" });
        return;
      }

      await session.followUp(text, undefined, { source: "extension" });
    };

    const dispose = async () => {
      const runner = session.extensionRunner;

      if (runner?.hasHandlers("session_shutdown")) {
        await Promise.race([
          runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined),
          timeout(SHUTDOWN_TIMEOUT_MS),
        ]);
      }

      session.dispose();
      listeners.clear();
    };

    return {
      id: spec.id,
      get sessionFile() {
        return session.sessionFile;
      },
      modelLabel,
      contextWindow: model.contextWindow,
      start: (task) => {
        session.prompt(task, { expandPromptTemplates: false, source: "extension" }).catch(failStart);
      },
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
      context: () => snapshotContext(session),
      ownUsage: (): UsageTotals => sumOwnUsage(session.sessionManager.getEntries()),
      lastText: () => session.getLastAssistantText() ?? "",
    };
  };

  const resolveModel = (request: string | undefined): ModelResolution => {
    const ctx = parent.ctx();

    if (!ctx) {
      return { kind: "invalid", request: request ?? "inherit", error: "no active pi session" };
    }

    return resolveFromCatalog(ctx, request, defaultProvider()).resolution;
  };

  return {
    spawn,
    readSession: (file) => readSessionFile(file, recordEntry),
    resolveModel,
    defaultThinking: () => parent.thinking(),
  };
};

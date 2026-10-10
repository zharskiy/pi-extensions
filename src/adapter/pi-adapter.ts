import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  AssistantMessageComponent,
  CustomMessageComponent,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  getMarkdownTheme,
  initTheme,
  keyText,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  matchesKey,
  ScrollView,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  AgentRuntime,
  AnyToolSpec,
  ChildEvent,
  ChildSession,
  CommandSpec,
  ContextSnapshot,
  Host,
  HostUi,
  KeyPress,
  MessageDelivery,
  ModelResolution,
  OverlayFactory,
  ScrollPane,
  SessionInfo,
  ShutdownReason,
  SpawnSpec,
  StopReason,
  ThemeLike,
  ToolResult,
  ToolSpec,
  TranscriptItem,
  TranscriptPane,
  UsageTotals,
  WidgetHandle,
} from "./contract.ts";
import { replaceMainPrompt } from "./main-prompt.ts";
import { type CatalogModel, resolveModel as matchCatalog } from "./model-resolver.ts";
import { formatRoutedMessage } from "./route.ts";
import { PROMPT_RECORD_ENTRY, readSessionFile } from "./session-file.ts";
import { sumOwnUsage, sumSessionUsage } from "./usage.ts";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const childScope = new AsyncLocalStorage<{ agentId: string }>();

export const insideChildSession = () => childScope.getStore() !== undefined;

const SHUTDOWN_TIMEOUT_MS = 2_000;

const themeLike = (theme: Theme): ThemeLike => ({
  fg: (token, text) => theme.fg(token, text),
  bold: (text) => theme.bold(text),
});

const keyPress = (data: string, isToolsToggle: (data: string) => boolean): KeyPress => {
  if (isToolsToggle(data)) {
    return { name: "toggleTools" };
  }

  const names = [
    ["up", Key.up],
    ["down", Key.down],
    ["pageUp", Key.pageUp],
    ["pageDown", Key.pageDown],
    ["home", Key.home],
    ["end", Key.end],
    ["enter", Key.enter],
    ["escape", Key.escape],
    ["space", Key.space],
    ["tab", Key.tab],
  ] as const;

  const match = names.find(([, key]) => matchesKey(data, key));

  if (match) {
    return { name: match[0] };
  }

  return { name: "other", char: data.length === 1 ? data : undefined };
};

const toPiResult = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  details: result.details,
  ...(result.usage ? { usage: result.usage } : {}),
  ...(result.isError ? { isError: true } : {}),
});

const fromPiResult = (result: {
  content?: { type: string; text?: string }[];
  details?: unknown;
}): ToolResult => ({
  text: (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n"),
  details: result.details,
});

const textComponent = (previous: unknown, text: string): Component => {
  if (previous instanceof Text) {
    previous.setText(text);
    return previous;
  }

  return new Text(text, 0, 0);
};

const fitLines = (lines: string[], width: number) => lines.map((line) => truncateToWidth(line, width));

const timeout = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const toPiTool = <P, D>(spec: ToolSpec<P, D>, onContext: (ctx: ExtensionContext) => void = () => {}) =>
  ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: Type.Unsafe<P>(spec.parameters),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: { type: "text"; text: string }[]; details: never }) => void) | undefined,
      ctx: ExtensionContext,
    ) => {
      onContext(ctx);

      const result = await spec.execute(params as P, {
        signal,
        update: (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined as never }),
      });

      return toPiResult(result as ToolResult) as never;
    },
    renderCall: spec.renderCall
      ? (args: unknown, theme: Theme, context: { lastComponent?: unknown }) =>
          textComponent(context.lastComponent, spec.renderCall?.(args as P, themeLike(theme)) ?? "")
      : undefined,
    renderResult: spec.renderResult
      ? (
          result: unknown,
          options: { expanded: boolean; isPartial: boolean },
          theme: Theme,
          context: { lastComponent?: unknown; invalidate: () => void },
        ) =>
          textComponent(
            context.lastComponent,
            spec.renderResult?.(
              fromPiResult(result as never) as ToolResult<D>,
              { expanded: options.expanded, isPartial: options.isPartial, invalidate: context.invalidate },
              themeLike(theme),
            ) ?? "",
          )
      : undefined,
  }) as unknown as ToolDefinition;

type HostState = {
  ctx?: ExtensionContext;
  stale: boolean;
};

const liveCtx = (state: HostState) => {
  if (state.stale || !state.ctx) {
    return undefined;
  }

  return state.ctx;
};

const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  dir: ctx.sessionManager.getSessionDir(),
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
  hasUI: ctx.mode === "tui",
  subscription: ctx.model
    ? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
    : false,
});

const toolDefinitionFactories: Record<string, (cwd: string) => object> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

type RawToolCall = { type: string; id?: string; name?: string; arguments?: unknown };

type RawAssistant = { content?: RawToolCall[]; stopReason?: string; errorMessage?: string };

type Expandable = Component & { setExpanded(expanded: boolean): void };

export const initRenderTheme = () => {
  initTheme(undefined, false);
};

export const createTranscriptPane = (tui: TUI, cwd: string, expanded: boolean): TranscriptPane => {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const definitions = new Map<string, object | undefined>();
  const expandables: Expandable[] = [];
  let toolsExpanded = expanded;
  let synced = 0;

  const definitionFor = (name: string) => {
    if (!definitions.has(name)) {
      definitions.set(name, toolDefinitionFactories[name]?.(cwd));
    }

    return definitions.get(name);
  };

  const addExpandable = (component: Expandable) => {
    component.setExpanded(toolsExpanded);
    expandables.push(component);
    container.addChild(component);
  };

  const addToolCall = (call: RawToolCall, message: RawAssistant) => {
    const id = call.id ?? "";
    const name = call.name ?? "tool";
    const component = new ToolExecutionComponent(
      name,
      id,
      call.arguments ?? {},
      {},
      definitionFor(name) as never,
      tui,
      cwd,
    );

    addExpandable(component);

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";

      component.updateResult({ content: [{ type: "text", text }], isError: true });
      return;
    }

    pendingTools.set(id, component);
  };

  const addItem = (item: TranscriptItem) => {
    if (item.kind === "user") {
      container.addChild(new UserMessageComponent(item.text, getMarkdownTheme()));
      return;
    }

    if (item.kind === "assistant") {
      const message = item.raw as RawAssistant;

      container.addChild(new AssistantMessageComponent(item.raw as never, true, getMarkdownTheme()));

      (message.content ?? [])
        .filter((part) => part.type === "toolCall")
        .forEach((call) => {
          addToolCall(call, message);
        });

      return;
    }

    if (item.kind === "tool") {
      pendingTools.get(item.toolCallId)?.updateResult(item.raw as never);
      pendingTools.delete(item.toolCallId);
      return;
    }

    if ((item.raw as { display?: boolean }).display !== false) {
      addExpandable(new CustomMessageComponent(item.raw as never, undefined, getMarkdownTheme()));
    }
  };

  const reset = () => {
    container.clear();
    pendingTools.clear();
    expandables.length = 0;
    synced = 0;
  };

  return {
    sync: (items) => {
      if (items.length < synced) {
        reset();
      }

      items.slice(synced).forEach(addItem);
      synced = items.length;
    },
    setToolsExpanded: (value) => {
      toolsExpanded = value;

      expandables.forEach((component) => {
        component.setExpanded(value);
      });
    },
    render: (width) => container.render(width),
  };
};

export const createScrollPane = (requestRender: () => void): ScrollPane => {
  let content: string[] = [];

  const view = new ScrollView({ render: () => content, invalidate: () => {} }, { follow: "end" });

  return {
    window: (lines, height) => {
      content = lines;
      view.updateLayout(lines.length, height, requestRender);

      return lines.slice(view.scrollTop, view.scrollTop + height);
    },
    scrollBy: (lines) => {
      view.scrollBy(lines);
    },
    scrollTo: (top) => {
      view.scrollTo(top);
    },
    scrollToStart: () => {
      view.scrollToStart();
    },
    scrollToEnd: () => {
      view.scrollToEnd();
    },
    state: () => ({
      top: view.scrollTop,
      height: view.viewportHeight,
      total: content.length,
      following: view.isFollowingEnd,
    }),
  };
};

const createUi = (state: HostState): HostUi => {
  const widgetTuis = new Map<string, TUI>();

  const tuiCtx = () => {
    const ctx = liveCtx(state);

    if (ctx?.mode !== "tui") {
      return undefined;
    }

    return ctx;
  };

  const setWidget: HostUi["setWidget"] = (key, render) => {
    const ctx = tuiCtx();
    const handle: WidgetHandle = { refresh: () => widgetTuis.get(key)?.requestRender() };

    if (!ctx) {
      return handle;
    }

    if (!render) {
      widgetTuis.delete(key);
      ctx.ui.setWidget(key, undefined);
      return handle;
    }

    ctx.ui.setWidget(
      key,
      (tui, theme) => {
        const widgetTheme = themeLike(theme);

        widgetTuis.set(key, tui);

        return {
          render: (width: number) => fitLines(render(width, widgetTheme), width),
          invalidate: () => {},
        };
      },
      { placement: "belowEditor" },
    );

    return handle;
  };

  const openOverlay = async (factory: OverlayFactory) => {
    const ctx = tuiCtx();

    if (!ctx) {
      return;
    }

    const cwd = ctx.cwd;
    const toolsExpanded = ctx.ui.getToolsExpanded();

    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        const view = factory({
          theme: themeLike(theme),
          rows: () => tui.terminal.rows,
          close: () => done(),
          requestRender: () => tui.requestRender(),
          toolsExpanded,
          toolsKey: keyText("app.tools.expand"),
          wheelScrolling: tui.mode === "fullscreen",
          createTranscript: () => createTranscriptPane(tui, cwd, toolsExpanded),
          createScroll: () => createScrollPane(() => tui.requestRender()),
        });

        const isToolsToggle = (data: string) => keybindings.matches(data, "app.tools.expand");

        return {
          render: (width: number) => fitLines(view.render(width), width),
          handleInput: (data: string) => {
            view.handleKey(keyPress(data, isToolsToggle));
            tui.requestRender();
          },
          handleMouse: (event: TuiMouseEvent) => {
            if (event.type !== "wheel" || !view.handleWheel) {
              return undefined;
            }

            view.handleWheel(event.wheelDelta ?? 0);

            return { handled: true };
          },
          invalidate: () => {},
          dispose: () => view.dispose?.(),
        };
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
    );
  };

  return {
    notify: (message, level = "info") => {
      liveCtx(state)?.ui.notify(message, level);
    },
    setStatus: (key, text) => {
      liveCtx(state)?.ui.setStatus(key, text);
    },
    setWidget,
    openOverlay,
    select: async (title, options) => {
      const ctx = liveCtx(state);

      if (!ctx?.hasUI) {
        return undefined;
      }

      return ctx.ui.select(title, options);
    },
  };
};

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  const sections = new Map<string, string>();
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
    state.stale = false;
  };

  pi.on("session_start", (_event, ctx) => {
    capture(ctx);

    const info = sessionInfo(ctx);

    startHandlers.forEach((handler) => {
      handler(info);
    });
  });

  pi.on("session_shutdown", async (event) => {
    await Promise.all(shutdownHandlers.map((handler) => handler(event.reason)));

    state.stale = true;
  });

  pi.on("before_agent_start", (event, ctx) => {
    capture(ctx);

    if (mainPrompt) {
      replaceMainPrompt(event.systemPromptOptions, mainPrompt);
    }

    sections.forEach((text, name) => {
      event.systemPromptOptions.sections[name] = text;
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    capture(ctx);

    idleHandlers.forEach((handler) => {
      handler();
    });
  });

  const registerTool = <P, D>(spec: ToolSpec<P, D>) => {
    pi.registerTool(toPiTool(spec, capture));
  };

  const registerCommand = (name: string, spec: CommandSpec) => {
    pi.registerCommand(name, {
      description: spec.description,
      getArgumentCompletions: spec.complete ? (prefix: string) => spec.complete?.(prefix) ?? null : undefined,
      handler: async (args, ctx) => {
        capture(ctx);
        await spec.run(args);
      },
    });
  };

  const readEntries = <T>(customType: string): T[] => {
    const ctx = liveCtx(state);

    if (!ctx) {
      return [];
    }

    return ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === customType)
      .map((entry) => (entry as { data: T }).data);
  };

  return {
    ui: createUi(state),
    registerTool,
    registerCommand,
    setPromptSection: (name, text) => {
      sections.set(name, text);
    },
    setMainPrompt: (text) => {
      mainPrompt = text;
    },
    onSessionStart: (handler) => {
      startHandlers.push(handler);
    },
    onSessionShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
    onIdle: (handler) => {
      idleHandlers.push(handler);
    },
    isIdle: () => liveCtx(state)?.isIdle() ?? true,
    sendUserMessage: (text) => {
      const ctx = liveCtx(state);

      if (!ctx) {
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
        return;
      }

      pi.sendUserMessage(text, { deliverAs: "followUp" });
    },
    appendEntry: (customType, data) => {
      if (!liveCtx(state)) {
        return;
      }

      pi.appendEntry(customType, data);
    },
    readEntries,
    sessionUsage: () => sumSessionUsage(liveCtx(state)?.sessionManager.getEntries() ?? []),
    session: () => {
      const ctx = liveCtx(state);

      return ctx ? sessionInfo(ctx) : undefined;
    },
  };
};

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

type ParentSource = {
  ctx(): ExtensionContext | undefined;
  settings(): Settings;
  thinking(): string;
};

type PiModel = NonNullable<ExtensionContext["model"]>;

const catalogOf = (ctx: ExtensionContext) => {
  const models = ctx.modelRegistry.getAll();
  const authByProvider = new Map<string, boolean>();

  const authenticated = (model: PiModel) => {
    const known = authByProvider.get(model.provider);

    if (known !== undefined) {
      return known;
    }

    const configured = ctx.modelRegistry.hasConfiguredAuth(model);

    authByProvider.set(model.provider, configured);

    return configured;
  };

  const catalog = models.map(
    (model): CatalogModel => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      authenticated: authenticated(model),
    }),
  );

  return { models, catalog };
};

const resolveFromCatalog = (
  ctx: ExtensionContext,
  request: string | undefined,
  defaultProvider: string | undefined,
): { resolution: ModelResolution; model?: PiModel } => {
  if (!request) {
    if (!ctx.model) {
      return {
        resolution: { kind: "invalid", request: "inherit", error: "the main session has no model selected" },
      };
    }

    const ref = `${ctx.model.provider}/${ctx.model.id}`;

    return {
      resolution: {
        kind: "resolved",
        request: "inherit",
        model: {
          ref,
          contextWindow: ctx.model.contextWindow,
          cost: { input: ctx.model.cost.input, output: ctx.model.cost.output },
        },
      },
      model: ctx.model,
    };
  }

  const { models, catalog } = catalogOf(ctx);
  const resolution = matchCatalog(request, catalog, {
    sessionProvider: ctx.model?.provider,
    defaultProvider,
  });

  if (resolution.kind !== "resolved") {
    return { resolution };
  }

  const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === resolution.model.ref);

  return { resolution, model };
};

const resolutionFailure = (resolution: ModelResolution) => {
  if (resolution.kind === "invalid") {
    return resolution.error;
  }

  return `model "${resolution.request}" is ${resolution.kind}; use an exact provider/id`;
};

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
  (agentId: string, emit: (event: ChildEvent) => void, modelLabel: string): ExtensionFactory =>
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

      pi.appendEntry(PROMPT_RECORD_ENTRY, {
        agentId,
        model: modelLabel,
        skills,
        guidelines,
        providerPayload: event.payload,
      });
    });
  };

const OWN_SOURCE_DIR = join(PACKAGE_ROOT, "src");

const isOwnExtension = (path: string) =>
  isAbsolute(path) && resolve(path).startsWith(`${OWN_SOURCE_DIR}${sep}`);

export const createPiRuntime = (parent: ParentSource): AgentRuntime => {
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
        extensions: result.extensions.filter((extension) => !isOwnExtension(extension.resolvedPath)),
      }),
      extensionFactories: [
        {
          name: "pi-subagents-child",
          hidden: true,
          factory: createChildExtension(spec.id, emit, modelLabel),
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

    await childScope.run(scope, () => session.bindExtensions({ mode: "print" }));

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

      emit({ type: "assistant_message", text: "", stopReason: "error", errorMessage: String(error) });
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

  return { spawn, readSession: readSessionFile, resolveModel, defaultThinking: () => parent.thinking() };
};

export type BootPaths = { packageRoot: string; agentDir: string };

export type Boot = (host: Host, runtime: AgentRuntime, paths: BootPaths) => void;

export const createPiExtension =
  (boot: Boot): ExtensionFactory =>
  (pi) => {
    if (insideChildSession()) {
      return;
    }

    const state: HostState = { stale: false };
    const host = createPiHost(pi, state);

    const runtime = createPiRuntime({
      ctx: () => liveCtx(state),
      settings: () => pi.getSettings(),
      thinking: () => pi.getThinkingLevel(),
    });

    boot(host, runtime, { packageRoot: PACKAGE_ROOT, agentDir: getAgentDir() });
  };

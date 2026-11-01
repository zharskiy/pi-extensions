import type { ContextFacts, ContextSnapshot, PromptTokens } from "./context.ts";
import type { HostUi } from "./host-ui.ts";
import type { CommandSpec, CustomMessage } from "./messages.ts";
import type { ModelInfo } from "./model.ts";
import type {
  AssistantEnd,
  DialogEvent,
  IdleInfo,
  Phase,
  SessionInfo,
  ShutdownReason,
  UserInput,
} from "./session.ts";
import type { ToolRows, ToolSpec } from "./tools.ts";
import type { UsageTotals } from "./usage.ts";
import type { EntryRender, MessageRender } from "./view.ts";

type ToolHost = {
  registerTool<P, D>(spec: ToolSpec<P, D>): void;
  registerCommand(name: string, spec: CommandSpec): void;
  dispatchCommand(name: string): void;
};

type PromptHost = {
  setMainPrompt(text: string): void;
  setPromptSection(name: string, text: string | undefined): void;
};

type LifecycleHost = {
  onSessionStart(handler: (info: SessionInfo) => void): void;
  onSessionShutdown(handler: (reason: ShutdownReason) => void | Promise<void>): void;
  onIdle(handler: (info: IdleInfo) => void): void;
  onTurnEnd(handler: (context: ContextSnapshot) => void): void;
  onCompact(handler: () => void): void;
  onInput(handler: (input: UserInput) => boolean): void;
  onAgentStart(handler: () => void): void;
  onAssistantStart(handler: () => void): void;
  onAssistantEnd(handler: (info: AssistantEnd) => void): void;
  onPhase(handler: (phase: Phase) => void): void;
  onDialog(handler: (event: DialogEvent) => void): void;
  onModelSelect(handler: (ref: string) => void | Promise<void>): void;
  onThinkingSelect(handler: (level: string) => void | Promise<void>): void;
  isIdle(): boolean;
};

type MessagingHost = {
  sendHiddenMessage(message: CustomMessage): void;
  sendMessage(message: CustomMessage): void;
  publish(channel: string, data: unknown): void;
  subscribe(channel: string, handler: (data: unknown) => void): () => void;
};

export type EntryHost = {
  appendEntry(customType: string, data: unknown): void;
  registerEntryRenderer(customType: string, render: EntryRender): void;
  registerToolRows(rows: ToolRows): void;
  registerMessageRenderer(customType: string, render: MessageRender): void;
  readEntries<T>(customType: string, file?: string): T[];
};

export type SessionHost = {
  session(): SessionInfo;
  sessionName(): string | undefined;
  sessionUsage(file?: string): UsageTotals;
  context(): ContextSnapshot;
  contextFacts(): ContextFacts | undefined;
  model(): ModelInfo | undefined;
  thinkingLevel(): string;
  setThinkingLevel(level: string): void;
  lastRequestUsage(): PromptTokens | undefined;
  mainRequestUsage(): PromptTokens;
  saveDefaultModel(ref: string): Promise<string | undefined>;
  saveDefaultThinkingLevel(level: string): Promise<string | undefined>;
};

export type Host = ToolHost &
  PromptHost &
  LifecycleHost &
  MessagingHost &
  EntryHost &
  SessionHost & {
    readonly ui: HostUi;
  };

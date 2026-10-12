type CostBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: CostBreakdown;
};

type JsonSchema = Record<string, unknown>;

export type ThemeToken = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text";

export type ThemeLike = {
  fg(token: ThemeToken, text: string): string;
  bold(text: string): string;
};

export type ToolResult<D = unknown> = {
  text: string;
  details?: D;
  isError?: boolean;
};

type ToolCallContext = {
  signal?: AbortSignal;
  update(text: string): void;
};

type ToolRenderState = {
  expanded: boolean;
  invalidate(): void;
};

export type ToolSpec<P = Record<string, unknown>, D = unknown> = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: JsonSchema;
  execute(params: P, ctx: ToolCallContext): Promise<ToolResult<D>>;
  renderCall?(params: P, theme: ThemeLike): string;
  renderResult?(result: ToolResult<D>, state: ToolRenderState, theme: ThemeLike): string;
};

export type AnyToolSpec = ToolSpec<never, unknown>;

type CompletionItem = { value: string; label: string };

type KeyName =
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "space"
  | "tab"
  | "toggleTools"
  | "other";

export type KeyPress = { name: KeyName; char?: string; raw?: string };

export type InputOutcome = "submitted" | "cancelled" | "changed";

export type InputPane = {
  feed(key: KeyPress): InputOutcome;
  value(): string;
  setValue(value: string): void;
  setFocused(focused: boolean): void;
  render(width: number): string[];
};

export type ViewComponent = {
  render(width: number): string[];
  handleKey(key: KeyPress): void;
  handleWheel?(lines: number): void;
  dispose?(): void;
};

export type TranscriptItem =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      text: string;
      thinking?: string;
      toolCalls: { name: string; args: unknown }[];
      raw: unknown;
    }
  | { kind: "tool"; toolName: string; toolCallId: string; text: string; isError: boolean; raw: unknown }
  | { kind: "custom"; customType: string; text: string; raw: unknown };

export type TranscriptPane = {
  sync(items: TranscriptItem[]): void;
  setToolsExpanded(expanded: boolean): void;
  render(width: number): string[];
};

type ScrollState = { top: number; height: number; total: number; following: boolean };

export type ScrollPane = {
  window(lines: string[], height: number): string[];
  scrollBy(lines: number): void;
  scrollTo(top: number): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  state(): ScrollState;
};

export type OverlayApi = {
  theme: ThemeLike;
  rows(): number;
  close(): void;
  requestRender(): void;
  toolsExpanded: boolean;
  toolsKey: string;
  wheelScrolling: boolean;
  createTranscript(): TranscriptPane;
  createScroll(): ScrollPane;
  createInput(placeholder: string): InputPane;
};

export type OverlayFactory = (api: OverlayApi) => ViewComponent;

export type WidgetHandle = { refresh(): void };

export type HostUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  setWidget(key: string, render: ((width: number, theme: ThemeLike) => string[]) | undefined): WidgetHandle;
  openOverlay(factory: OverlayFactory): Promise<void>;
  select(title: string, options: string[]): Promise<string | undefined>;
  style(token: ThemeToken, text: string): string;
  terminalNotify(title: string, body: string): void;
};

export type ContextSnapshot = { tokens: number | null; window: number; percent: number | null };

export type RunMode = "tui" | "rpc" | "print" | "json";

export type SessionInfo = {
  id: string;
  file?: string;
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  subscription: boolean;
  mode: RunMode;
};

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export type NewSessionOptions = { parentSession?: string; seed?: { customType: string; text: string } };

export type SessionControl = {
  newSession(options: NewSessionOptions): Promise<boolean>;
};

export type CommandSpec = {
  description: string;
  complete?(prefix: string): CompletionItem[] | null;
  run(args: string, control: SessionControl): Promise<void> | void;
};

export type Host = {
  readonly ui: HostUi;
  registerTool<P, D>(spec: ToolSpec<P, D>): void;
  registerCommand(name: string, spec: CommandSpec): void;
  setMainPrompt(text: string): void;
  onSessionStart(handler: (info: SessionInfo) => void): void;
  onSessionShutdown(handler: (reason: ShutdownReason) => void | Promise<void>): void;
  onIdle(handler: () => void): void;
  onTurnEnd(handler: (context: ContextSnapshot) => void): void;
  onCompact(handler: () => void): void;
  isIdle(): boolean;
  sendUserMessage(text: string): void;
  dispatchCommand(name: string, args?: string): void;
  publish(channel: string, data: unknown): void;
  subscribe(channel: string, handler: (data: unknown) => void): () => void;
  appendEntry(customType: string, data: unknown): void;
  readEntries<T>(customType: string): T[];
  sessionUsage(): UsageTotals;
  session(): SessionInfo | undefined;
};

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "deferred";

export type ChildEvent =
  | { type: "turn_end"; context: ContextSnapshot }
  | {
      type: "assistant_message";
      text: string;
      stopReason: StopReason;
      toolCalls: number;
      errorMessage?: string;
    }
  | { type: "tool_start"; toolName: string }
  | { type: "settled"; aborted: boolean };

export type MessageDelivery = "steer" | "followUp";

export type RoutedMessage = { sender: string; text: string };

export type ChildSession = {
  readonly id: string;
  readonly sessionFile: string | undefined;
  start(task: string): void;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  send(message: RoutedMessage, delivery: MessageDelivery): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  ownUsage(): UsageTotals;
  lastText(): string;
  wake(text: string): Promise<void>;
};

export type ChildPrompts = {
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
};

export type SpawnSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  parentSessionFile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  promptAppend: string[];
  reserveTokens: number;
  customTools?: AnyToolSpec[];
  prompts?: ChildPrompts;
};

export type PromptSection = { name: string; text: string };

export type PromptTool = { name: string; description: string; parameters: unknown };

export type PromptRecord = {
  sections: PromptSection[];
  tools: PromptTool[];
  skills: { name: string; description: string }[];
  guidelines: string[];
  providerPayload?: unknown;
  model?: string;
};

export type SessionRecord = {
  prompt: PromptRecord;
  items: TranscriptItem[];
  contextTokens?: number;
};

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type ModelRequest = { name: string; thinking?: string; error?: string };

export const splitModelRequest = (request: string): ModelRequest => {
  const trimmed = request.trim();
  const colon = trimmed.lastIndexOf(":");

  if (colon < 0) {
    return { name: trimmed };
  }

  const suffix = trimmed.slice(colon + 1).toLowerCase();
  const name = trimmed.slice(0, colon).trim();

  if (THINKING_LEVELS.includes(suffix)) {
    return { name, thinking: suffix };
  }

  if (/^[a-z]+$/.test(suffix)) {
    return {
      name,
      error: `invalid thinking level "${suffix}" in "${trimmed}"; use one of ${THINKING_LEVELS.join(", ")}`,
    };
  }

  return { name: trimmed };
};

export type ModelChoice = {
  ref: string;
  contextWindow: number;
  cost: { input: number; output: number };
};

export type ModelResolution =
  | { kind: "resolved"; request: string; model: ModelChoice; thinking?: string }
  | { kind: "ambiguous"; request: string; candidates: ModelChoice[] }
  | {
      kind: "unknown";
      request: string;
      candidates: ModelChoice[];
      withoutCredentials: ModelChoice[];
    }
  | { kind: "invalid"; request: string; error: string };

export type AgentRuntime = {
  spawn(spec: SpawnSpec): Promise<ChildSession>;
  readSession(file: string): SessionRecord;
  resolveModel(request: string | undefined): ModelResolution;
  defaultThinking(): string;
  estimateTokens(text: string): number;
};

export const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export const addUsage = (left: UsageTotals, right: UsageTotals): UsageTotals => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  totalTokens: left.totalTokens + right.totalTokens,
  cost: {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
    total: left.cost.total + right.cost.total,
  },
});

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type ThemeToken =
  | "accent"
  | "border"
  | "borderAccent"
  | "syntaxVariable"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "text"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax";

export type BgToken = "added" | "removed" | "addedWord" | "removedWord";

export type ThemeLike = {
  fg(token: ThemeToken, text: string): string;
  bg(token: BgToken, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
  readonly panels: boolean;
  width(text: string): number;
  truncate(text: string, cols: number): string;
  wrap(text: string, cols: number): string[];
};

export type ToolResult<D = unknown> = {
  text: string;
  details?: D;
  isError?: boolean;
};

export type ToolRenderState = {
  toolCallId: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  args: unknown;
  durationMs?: number;
  aborted: boolean;
  result?: ToolResult;
  invalidate(): void;
};

export type ToolRender = string | ((width: number) => string);

export type ToolSpec<P = Record<string, unknown>, D = unknown> = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  executionMode?: "sequential" | "parallel";
  modelOnly?: boolean;
  renderShell?: "default" | "row";
  execute(
    params: P,
    ctx: { signal?: AbortSignal; toolCallId?: string; update(text: string, details?: D): void },
  ): Promise<ToolResult<D>>;
  pendingResult?(toolCallId: string, owner: string | undefined): ToolResult<D> | undefined;
  renderCall?(params: P, theme: ThemeLike, state: ToolRenderState): ToolRender;
  renderResult?(result: ToolResult<D>, state: ToolRenderState, theme: ThemeLike): ToolRender;
};

export type AnyToolSpec = ToolSpec<never, unknown>;

export type RowLines = (width: number, theme: ThemeLike) => string[];

export type ToolCallView = {
  name: string;
  args: unknown;
  argsComplete: boolean;
  started: boolean;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  cwd: string;
  durationMs?: number;
  aborted: boolean;
  label?: string;
  result?: ToolResult & { images: number };
};

export type ToolRow = { call: RowLines; result?: RowLines; piBody?: boolean; dropTiming?: boolean };

export type ToolRows = (view: ToolCallView) => ToolRow | undefined;

export type KeyPress = {
  name:
    | "up"
    | "down"
    | "left"
    | "right"
    | "pageUp"
    | "pageDown"
    | "home"
    | "end"
    | "enter"
    | "escape"
    | "space"
    | "tab"
    | "backTab"
    | "backspace"
    | "toggleTools"
    | "other";
  char?: string;
  raw?: string;
};

export type ViewComponent = {
  render(width: number): string[];
  handleKey(key: KeyPress): void;
  handleWheel?(lines: number): void;
  handleClick?(x: number, y: number): boolean;
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
  click(line: number, column: number, width: number): boolean;
};

export type ScrollPane = {
  window(lines: string[], height: number): string[];
  scrollBy(lines: number): void;
  scrollTo(top: number, options?: { disableFollow?: boolean }): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  state(): { top: number; height: number; total: number; following: boolean };
};

export type OverlayApi = {
  theme: ThemeLike;
  rows(): number;
  close(): void;
  requestRender(): void;
  toolsKey: string;
  createTranscript(options?: { owner?: string }): TranscriptPane;
  createScroll(): ScrollPane;
};

export type OverlayFactory = (api: OverlayApi) => ViewComponent;

export type TextInput = {
  render(width: number): string[];
  handleKey(key: KeyPress): void;
  text(): string;
  setText(text: string): void;
  onSubmit(handler: (text: string) => void): void;
};

export type FormApi<T> = {
  theme: ThemeLike;
  requestRender(): void;
  done(result: T): void;
  createTextInput(): TextInput;
};

export type FormFactory<T> = (api: FormApi<T>) => ViewComponent;

export type WidgetHandle = { refresh(): void };

export type EditorLayout = { bottom: number; scrolled: boolean };

export type EditorFrame = {
  chrome: number;
  left: number;
  minWidth: number;
  decorate(
    lines: string[],
    layout: EditorLayout,
    paint: (text: string) => string,
    theme: ThemeLike,
  ): string[];
};

export type NotifyChannel = "auto" | "bell";

export type EditorKeyHandler = (key: KeyPress) => "consumed" | "release";

export type HostUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setNotice(key: string, text: string | undefined): void;
  confirm(title: string, message: string): Promise<boolean>;
  setWidget(key: string, render: ((width: number, theme: ThemeLike) => string[]) | undefined): WidgetHandle;
  openOverlay(factory: OverlayFactory): Promise<void>;
  showForm<T>(factory: FormFactory<T>, options?: { signal?: AbortSignal }): Promise<T | undefined>;
  style(token: ThemeToken, text: string): string;
  terminalNotify(message: string, channel: NotifyChannel): void;
  setWorkingMessage(text: string | undefined): void;
  setWorkingVisible(visible: boolean): void;
  onEditorSubmit(rewrite: (text: string) => string | undefined): () => void;
  mapCommandCompletion(map: (command: string) => string | undefined): void;
  submitEditor(text: string): Promise<boolean>;
  setEditorFrame(frame: EditorFrame | undefined): void;
  onEmptyEditorLeft(handler: () => void): () => void;
  onEmptyEditorDown(handler: () => void): () => void;
  onEmptyEditorEscape(handler: () => boolean): () => void;
  captureEditorKeys(handler: EditorKeyHandler): () => void;
  setFooter(render: FooterRender | undefined): WidgetHandle;
  keyText(binding: string): string;
  onKeyPress(listener: () => void): () => void;
  setHiddenThinkingLabel(label: string | undefined, hint?: string): void;
  workingColumns(): number | undefined;
  readonly metrics: Pick<ThemeLike, "width" | "truncate">;
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
  complete?(prefix: string): { value: string; label: string }[] | null;
  run(args: string, control: SessionControl): Promise<void> | void;
};

export type Phase = "waiting" | "thinking" | "writing" | "toolArgs" | "tool" | "idle";

export type RunningTool = { name: string; args: unknown; label?: string };

export type PhaseDetail = { toolName?: string; tools?: RunningTool[] };

export type DialogKind = "select" | "confirm" | "input" | "editor" | "custom";

export type DialogEvent = { phase: "start" | "end"; kind: DialogKind; title?: string };

export type PromptTokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type ContextSection = { name: string; text: string };

export type ToolSource = "builtin" | "mcp" | "extension";

export type ContextTool = { name: string; source: ToolSource; onDemand: boolean; chars: number };

export type MessageBlock = { type: string; tokens: number };

export type ContextMessage = { role: string; tokens: number; blocks: MessageBlock[] };

export type ContextFacts = {
  model: string | undefined;
  window: number;
  total: number | null;
  reserve: number;
  sections: ContextSection[];
  tools: ContextTool[];
  messages: ContextMessage[];
};

export type EntryRender = (data: unknown, width: number, expanded: boolean, theme: ThemeLike) => string[];

export type MessageRender = (
  message: { text: string; details?: unknown },
  width: number,
  expanded: boolean,
  theme: ThemeLike,
) => string[];

export type IdleInfo = { aborted: boolean };

export type HiddenMessage = { customType: string; text: string; details?: unknown };

export type Host = {
  readonly ui: HostUi;
  registerTool<P, D>(spec: ToolSpec<P, D>): void;
  registerCommand(name: string, spec: CommandSpec): void;
  setMainPrompt(text: string): void;
  setPromptSection(name: string, text: string | undefined): void;
  onSessionStart(handler: (info: SessionInfo, parent?: string) => void): void;
  onSessionShutdown(handler: (reason: ShutdownReason) => void | Promise<void>): void;
  onIdle(handler: (info: IdleInfo) => void): void;
  onTurnEnd(handler: (context: ContextSnapshot) => void): void;
  onCompact(handler: () => void): void;
  isIdle(): boolean;
  sendUserMessage(text: string): void;
  sendHiddenMessage(message: HiddenMessage): void;
  dispatchCommand(name: string, args?: string): void;
  publish(channel: string, data: unknown): void;
  subscribe(channel: string, handler: (data: unknown) => void): () => void;
  appendEntry(customType: string, data: unknown): void;
  registerEntryRenderer(customType: string, render: EntryRender): void;
  registerToolRows(rows: ToolRows): void;
  registerMessageRenderer(customType: string, render: MessageRender): void;
  readEntries<T>(customType: string, file?: string): T[];
  sessionUsage(file?: string): UsageTotals;
  session(): SessionInfo;
  onAgentStart(handler: () => void): void;
  onPhase(handler: (phase: Phase, detail: PhaseDetail) => void): void;
  onDialog(handler: (event: DialogEvent) => void): void;
  context(): ContextSnapshot;
  model(): ModelInfo | undefined;
  thinkingLevel(): string;
  sessionName(): string | undefined;
  contextFacts(): ContextFacts | undefined;
  lastRequestUsage(): PromptTokens | undefined;
  mainRequestUsage(): PromptTokens;
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
  runTexts(): string[];
  wake(text: string): Promise<void>;
};

export type SpawnSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  parentSessionFile?: string;
  model: string;
  thinking: string;
  tools?: string[];
  skills: string[];
  mcp?: boolean;
  promptAppend: string[];
  reserveTokens: number;
  customTools: AnyToolSpec[];
};

export type PromptSection = { name: string; text: string };

export type PromptTool = { name: string; description: string; parameters: unknown };

export type SkillInfo = { name: string; description: string };

export type PromptRecord = {
  sections: PromptSection[];
  tools: PromptTool[];
  skills: SkillInfo[];
  guidelines: string[];
  providerPayload?: unknown;
  model?: string;
};

export type SessionRecord = {
  prompt: PromptRecord;
  items: TranscriptItem[];
  contextTokens?: number;
};

export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const splitModelRequest = (request: string): { name: string; thinking?: string; error?: string } => {
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
  | { kind: "resolved"; request: string; model: ModelChoice }
  | { kind: "ambiguous"; request: string; candidates: ModelChoice[] }
  | {
      kind: "unknown";
      request: string;
      candidates: ModelChoice[];
      withoutCredentials: ModelChoice[];
    }
  | { kind: "invalid"; request: string; error: string };

export type AvailableModel = ModelChoice & { thinking: string[] };

export type CodemodeShortfall = { setting: string; workers: number; wanted: number };

export type AgentRuntime = {
  spawn(spec: SpawnSpec): Promise<ChildSession>;
  readSession(file: string): SessionRecord;
  resolveModel(request: string | undefined): ModelResolution;
  availableModels(): AvailableModel[];
  defaultThinking(): string;
  skillCatalog(): SkillInfo[];
  skillNames(): string[];
  sessionSkillNames(): string[];
  reserveCodemodeWorkers(agentSessions: number): CodemodeShortfall | undefined;
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

export type FooterData = { branch: string | null; statuses: ReadonlyMap<string, string> };

export type FooterRender = (width: number, theme: ThemeLike, data: FooterData) => string[];

export type ModelInfo = { name: string; contextWindow: number; reasoning: boolean };

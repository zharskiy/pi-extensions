export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

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

/** Render-time facts pi passes to tool renderers (ToolRenderContext in pi). */
export type ToolRenderState = {
  toolCallId: string;
  expanded: boolean;
  /** True while the call streams or the result is partial. */
  isPartial: boolean;
  executionStarted: boolean;
  isError: boolean;
  /** The call's arguments as pi parsed them (pi's `ToolRenderContext.args`, shared by the call and result renders of one call); the tool's params type, `unknown` here because the state is not generic. */
  args: unknown;
  /** Set only on the final result. */
  durationMs?: number;
  /** pi's horizontal transcript padding (`ToolRenderContext.outputPad`, 0 or 1, default 1). A `renderShell: "self"` block is not padded by pi; the adapter applies it, the renderer may read it. */
  outputPad: number;
  /** Re-render this call later (safe after the tool returned, until the transcript is rebuilt). */
  invalidate(): void;
};

export type ToolSpec<P = Record<string, unknown>, D = unknown> = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  /** "self" drops pi's coloured box so the renderer owns the whole row; the adapter indents each line by pi's `outputPad` and cuts it at `width - 2 * outputPad` (never wraps). Default "default". */
  renderShell?: "default" | "self";
  execute(
    params: P,
    ctx: { signal?: AbortSignal; update(text: string, details?: D): void },
  ): Promise<ToolResult<D>>;
  renderCall?(params: P, theme: ThemeLike, state: ToolRenderState): string;
  renderResult?(result: ToolResult<D>, state: ToolRenderState, theme: ThemeLike): string;
};

export type AnyToolSpec = ToolSpec<never, unknown>;

export type KeyPress = {
  name:
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
  char?: string;
  raw?: string;
};

export type InputPane = {
  feed(key: KeyPress): "submitted" | "cancelled" | "changed";
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

export type ScrollPane = {
  window(lines: string[], height: number): string[];
  scrollBy(lines: number): void;
  scrollTo(top: number): void;
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
  wheelScrolling: boolean;
  /** `tools` render with their own `renderCall`/`renderResult` (after pi's built-ins, before codemode and tool_search). */
  createTranscript(options?: { tools?: AnyToolSpec[] }): TranscriptPane;
  createScroll(): ScrollPane;
  createInput(placeholder: string): InputPane;
};

export type OverlayFactory = (api: OverlayApi) => ViewComponent;

export type WidgetHandle = { refresh(): void };

export type WorkingIndicator = { frames: string[]; intervalMs: number };

export type EditorLayout = { bottom: number; scrolled: boolean };

export type EditorFrame = {
  chrome: number;
  left: number;
  minWidth: number;
  decorate(lines: string[], layout: EditorLayout, paint: (text: string) => string): string[];
};

export type NotifyChannel = "auto" | "bell";

/** Keys the editor sees while a capture is installed. `up`/`down` follow pi's `tui.editor.cursorUp/Down` bindings. */
export type EditorKeyHandler = (key: KeyPress) => "consumed" | "release";

export type HostUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  setWidget(key: string, render: ((width: number, theme: ThemeLike) => string[]) | undefined): WidgetHandle;
  openOverlay(factory: OverlayFactory): Promise<void>;
  select(title: string, options: string[]): Promise<string | undefined>;
  style(token: ThemeToken, text: string): string;
  /** tui only. `bell` writes BEL. `auto` writes only a desktop notification with `message`, no BEL: OSC 9, or OSC 777 titled `pi` when TERM or TERM_PROGRAM names rxvt. Control characters in `message` become spaces. */
  terminalNotify(message: string, channel: NotifyChannel): void;
  setWorkingIndicator(indicator: WorkingIndicator | undefined): void;
  setWorkingMessage(text: string | undefined): void;
  /** Show or hide pi's working row; tui only. Hiding is immediate. Showing is immediate while a run is active, otherwise pi applies it at the next turn_start. The flag persists until set again; pi resets it to true on session switch and reload. */
  setWorkingVisible(visible: boolean): void;
  onEditorSubmit(rewrite: (text: string) => string | undefined): () => void;
  mapCommandCompletion(map: (command: string) => string | undefined): void;
  submitEditor(text: string): Promise<boolean>;
  setEditorFrame(frame: EditorFrame | undefined): void;
  /**
   * Fires when `tui.editor.cursorLeft` is pressed in the focused editor while it is empty and no autocomplete is open
   * (an empty editor has the cursor at column 0 of its only line, so the key would be a no-op). The key is consumed. tui only; silently
   * inactive when another extension installed its own editor. Returns an unsubscribe function.
   */
  onEmptyEditorLeft(handler: () => void): () => void;
  /**
   * Routes every key the focused editor receives to `handler` until it returns "release" or the returned function is
   * called. "consumed" swallows the key (it never reaches pi: no `app.interrupt` on Esc, no shortcuts, no text edit);
   * "release" ends the capture and lets the editor handle that same key normally. Keys never reach the handler while
   * an overlay or dialog has focus. At most one capture at a time: installing a second one releases the first.
   */
  captureEditorKeys(handler: EditorKeyHandler): () => void;
  setFooter(render: FooterRender | undefined): WidgetHandle;
  keyText(binding: string): string;
  /** Calls `listener` on every keyboard input chunk (mouse reports and key-release events excluded) without consuming it. tui only. Returns an unsubscribe function. */
  onKeyPress(listener: () => void): () => void;
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

/** What the main session is doing right now, derived from pi's turn events (see pi-phase.ts). */
export type Phase = "waiting" | "thinking" | "writing" | "toolArgs" | "tool" | "idle";

/** `toolName` is the most recently started top-level tool still running; `running` counts them. Both are 0/unset outside `tool`. */
export type PhaseDetail = { toolName?: string; running: number };

export type DialogKind = "select" | "confirm" | "input" | "editor" | "custom";

export type DialogEvent = { phase: "start" | "end"; kind: DialogKind; title?: string };

/** A message for the model that the user does not see. `details` is persisted with the custom_message entry. */
export type HiddenMessage = { customType: string; text: string; details?: unknown };

export type Host = {
  readonly ui: HostUi;
  registerTool<P, D>(spec: ToolSpec<P, D>): void;
  registerCommand(name: string, spec: CommandSpec): void;
  setMainPrompt(text: string): void;
  onSessionStart(handler: (info: SessionInfo, parent?: string) => void): void;
  onSessionShutdown(handler: (reason: ShutdownReason) => void | Promise<void>): void;
  onIdle(handler: () => void): void;
  onTurnEnd(handler: (context: ContextSnapshot) => void): void;
  onCompact(handler: () => void): void;
  isIdle(): boolean;
  sendUserMessage(text: string): void;
  /**
   * Delivers `message` to the model without rendering it. A follow-up is used only while an agent run is active
   * (between pi's `agent_start` and `agent_settled`): it is then queued as a hidden follow-up of that run. When idle it
   * is parked for the next turn and `visible` (a short user-role line, rendered as a user message) starts that turn,
   * so the main prompt replacement (`setMainPrompt`) applies. When pi is busy without a run (compaction, a branch
   * summary), the message is held and delivered the idle way once pi is idle. `visible` is required: without a live
   * session nothing is sent, and held messages are dropped at session shutdown.
   */
  sendHiddenMessage(message: HiddenMessage, visible: string): void;
  /** Register a renderer for custom entries (`appendEntry`). `undefined` hides the entry. The adapter indents every line by pi's `outputPad` and cuts it at `width - 2 * outputPad` with `…` (never wraps). */
  registerEntryRenderer<T>(
    customType: string,
    render: (data: T, state: { expanded: boolean }, theme: ThemeLike) => string[] | undefined,
  ): void;
  dispatchCommand(name: string, args?: string): void;
  publish(channel: string, data: unknown): void;
  subscribe(channel: string, handler: (data: unknown) => void): () => void;
  appendEntry(customType: string, data: unknown): void;
  readEntries<T>(customType: string, file?: string): T[];
  sessionUsage(file?: string): UsageTotals;
  session(): SessionInfo;
  onAgentStart(handler: () => void): void;
  /** Fires on every phase or detail change. `idle` fires once per settled run, after the `onIdle` handlers. Nothing fires at session start. */
  onPhase(handler: (phase: Phase, detail: PhaseDetail) => void): void;
  /** Current phase; `idle` without a live session. */
  phase(): { phase: Phase; detail: PhaseDetail };
  /** pi's ui_prompt_start/ui_prompt_end: one outer dialog at a time, nested dialogs are folded into it. Overlays opened with openOverlay report kind "custom". */
  onDialog(handler: (event: DialogEvent) => void): void;
  context(): ContextSnapshot;
  model(): ModelInfo | undefined;
  thinkingLevel(): string;
  sessionName(): string | undefined;
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

export type SpawnSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  parentSessionFile?: string;
  model: string;
  thinking: string;
  tools?: string[];
  skills?: string[];
  promptAppend: string[];
  reserveTokens: number;
  customTools: AnyToolSpec[];
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

export type FooterData = { branch: string | null; statuses: ReadonlyMap<string, string> };

export type FooterRender = (width: number, theme: ThemeLike, data: FooterData) => string[];

export type ModelInfo = { name: string; contextWindow: number; reasoning: boolean };

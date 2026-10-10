import type { AnyToolSpec, ContextSnapshot, RoutedMessage, UsageTotals } from "../adapter/contract.ts";

export const MAIN_CALLER = "main";

export type AgentState = "queued" | "running" | "grace" | "done" | "failed" | "stopped" | "handoff";

export const CLOSED_STATES: ReadonlySet<AgentState> = new Set(["done", "failed", "stopped", "handoff"]);

export const isClosed = (state: AgentState) => CLOSED_STATES.has(state);

export type AgentRecord = {
  id: string;
  agent: string;
  task: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  state: AgentState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  tokens: number;
  context?: ContextSnapshot;
  lastText: string;
  resultText?: string;
  resultPath?: string;
  handoffPath: string;
  error?: string;
  dir: string;
  sessionFile?: string;
  model?: string;
  budgetTokens: number;
  handoffRequested: boolean;
  graceEndsAt?: number;
  version: number;
};

export type AgentInput = "task" | "files";

export type AgentOutput = "text" | "file";

export type AgentSource = "builtin" | "user" | "project";

export type AgentDefinition = {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  prompt: string;
  input: AgentInput;
  output: AgentOutput;
  maxTurns?: number;
  limit: number;
  subagents: string[];
  fallback: boolean;
  source: AgentSource;
  path: string;
};

export type DefinitionError = { path: string; message: string };

export type NewAgent = {
  agent: string;
  task: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  dir: string;
  budgetTokens: number;
  model?: string;
};

export type AgentRegistry = {
  create(input: NewAgent): AgentRecord;
  get(id: string): AgentRecord | undefined;
  list(): AgentRecord[];
  batch(batchId: string): AgentRecord[];
  update(id: string, patch: Partial<AgentRecord>): AgentRecord;
  close(id: string, patch: Partial<AgentRecord> & { state: AgentState }): AgentRecord;
};

export type AgentDefinitions = {
  get(name: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
  errors(): ReadonlyArray<DefinitionError>;
  reload(): void;
  mainPrompt(): string;
  promptAppend(definition: AgentDefinition): string[];
};

export type SpendLedger = {
  record(agentId: string, usage: UsageTotals): void;
  persist(agentId: string): void;
  agentsTotal(): UsageTotals;
  deliveredTotal(): UsageTotals;
  takeUndelivered(): UsageTotals | undefined;
  restore(): void;
};

export type RouteResult =
  | { ok: true; delivery: "steer" | "followUp" | "held" }
  | { ok: false; error: string };

export type AgentRunner = {
  stop(id: string): Promise<boolean>;
  route(id: string, message: RoutedMessage): Promise<RouteResult>;
  abort(id: string, reason: string): Promise<void>;
};

export type HandoffValidation = { ok: true; status: string } | { ok: false; errors: string[] };

export type HandoffService = {
  instruction(path: string): string;
  validate(text: string): HandoffValidation;
};

export type AgentStatusService = {
  toolFor(callerId: string): AnyToolSpec;
};

export type ServiceMap = {
  registry: AgentRegistry;
  definitions: AgentDefinitions;
  ledger: SpendLedger;
  runner: AgentRunner;
  handoff: HandoffService;
  agentStatus: AgentStatusService;
};

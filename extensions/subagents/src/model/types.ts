import type { AnyToolSpec, ContextSnapshot, RoutedMessage } from "../../../../core/adapter/contract.ts";
import type { HandoffValidation } from "../../../../core/manager/handoff.ts";
import { type AgentFrontmatter, ALL, type Grant } from "./agent-schema.ts";

export const MAIN_CALLER = "main";

export type AgentState = "queued" | "running" | "grace" | "done" | "failed" | "stopped" | "handoff";

const CLOSED_STATES: ReadonlySet<AgentState> = new Set(["done", "failed", "stopped", "handoff"]);

export const isClosed = (state: AgentState) => CLOSED_STATES.has(state);

export const chainTerminal = (registry: Pick<AgentRegistry, "get">, record: AgentRecord): AgentRecord => {
  const successor = record.successorId ? registry.get(record.successorId) : undefined;

  return successor ? chainTerminal(registry, successor) : record;
};

export const chainLinks = (registry: Pick<AgentRegistry, "get">, record: AgentRecord): AgentRecord[] => {
  const predecessor = record.predecessorId ? registry.get(record.predecessorId) : undefined;
  const earlier = predecessor ? chainLinks(registry, predecessor) : [];

  earlier.push(record);

  return earlier;
};

export type AttentionKind = "confirm" | "select" | "input";

export type Attention = { kind: AttentionKind; title: string; since: number };

export type Worktree = { path: string; branch: string; cwd: string };

export const worktreeText = (worktree: Worktree) => `${worktree.path} (branch ${worktree.branch})`;

export type AgentRecord = {
  id: string;
  agent: string;
  task: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  chainIndex: number;
  predecessorId?: string;
  successorId?: string;
  attention?: Attention;
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
  worktree?: Worktree;
  contextLimit: number;
  handoffRequested: boolean;
  graceEndsAt?: number;
  version: number;
};

export type AgentSource = "builtin" | "user" | "project";

export const allowlist = (grant: Grant): string[] | undefined => (grant === ALL ? undefined : grant);

export const isNone = (grant: Grant) => grant !== ALL && grant.length === 0;

export const grantText = (grant: Grant) => (grant === ALL ? ALL : grant.join(", "));

export const subagentNames = (definition: Pick<AgentDefinition, "name" | "subagents">, names: string[]) =>
  definition.subagents === ALL ? names.filter((name) => name !== definition.name) : definition.subagents;

export type AgentInternals = {
  thinking?: string;
  prompt: string;
  source: AgentSource;
  path: string;
};

export type AgentDefinition = AgentFrontmatter & AgentInternals;

export type DefinitionError = { path: string; message: string };

export type NewAgent = {
  agent: string;
  task: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  dir: string;
  contextLimit: number;
  model?: string;
  chainIndex?: number;
  predecessorId?: string;
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
  reload(): void;
  promptAppend(definition: AgentDefinition): string[];
};

export type RouteResult =
  | { ok: true; delivery: "steer" | "followUp" | "held" }
  | { ok: false; error: string };

export type AgentRunner = {
  batchSettled(batchId: string): boolean;
  stop(id: string): Promise<boolean>;
  route(id: string, message: RoutedMessage): Promise<RouteResult>;
  abort(id: string, reason: string): Promise<void>;
};

export type HandoffService = {
  instruction(path: string): string;
  validate(text: string): HandoffValidation;
};

type AgentStatusService = {
  toolFor(callerId: string): AnyToolSpec;
};

type AgentViewService = {
  open(id: string): Promise<void>;
};

type AgentListService = {
  open(): Promise<void>;
};

export type ServiceMap = {
  registry: AgentRegistry;
  agentView: AgentViewService;
  agentList: AgentListService;
  definitions: AgentDefinitions;
  runner: AgentRunner;
  handoff: HandoffService;
  agentStatus: AgentStatusService;
};

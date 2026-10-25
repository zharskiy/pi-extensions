import type { AnyToolSpec, ContextSnapshot, RoutedMessage } from "../../../../platform/pi-adapter/index.ts";
import type { HandoffValidation } from "../../../../platform/shared/index.ts";
import { AGENT_SCOPE_ALL, type AgentFrontmatter, type Grant } from "./agent-schema.ts";

export const MAIN_CALLER = "main";

export type AgentState = "queued" | "running" | "grace" | "done" | "failed" | "stopped" | "handoff";

export const isClosed = (state: AgentState) => state !== "queued" && state !== "running" && state !== "grace";

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

export type WorktreeCleanup = "removed" | "branch kept" | "kept";

export type Worktree = { path: string; branch: string; base: string; cwd: string; cleanup?: WorktreeCleanup };

export const worktreeText = (worktree: Worktree) => {
  const checkout = `${worktree.path} (branch ${worktree.branch})`;

  if (worktree.cleanup === "removed") {
    return "removed";
  }

  if (worktree.cleanup === "branch kept") {
    return `removed; branch ${worktree.branch} kept`;
  }

  return worktree.cleanup === "kept" ? `kept: ${checkout}` : checkout;
};

export type AgentRecord = {
  id: string;
  agent: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  chainIndex: number;
  predecessorId?: string;
  successorId?: string;
  activity?: string;
  state: AgentState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  tokens: number;
  cost: number;
  context?: ContextSnapshot;
  lastText: string;
  resultText?: string;
  statusLine?: boolean;
  resultPath?: string;
  handoffPath: string;
  error?: string;
  dir: string;
  sessionFile?: string;
  model?: string;
  skills?: string[];
  worktree?: Worktree;
  contextLimit: number;
  handoffRequested: boolean;
  graceEndsAt?: number;
};

export type AgentSource = "builtin" | "user" | "project";

export const allowlist = (grant: Grant): string[] | undefined =>
  grant === AGENT_SCOPE_ALL ? undefined : grant;

export const isNone = (grant: Grant) => grant !== AGENT_SCOPE_ALL && grant.length === 0;

export const grantText = (grant: Grant) => (grant === AGENT_SCOPE_ALL ? AGENT_SCOPE_ALL : grant.join(", "));

export const grantOrNone = (grant: Grant) => grantText(grant) || "none";

export const sameGrant = (left: Grant, right: Grant) =>
  left === AGENT_SCOPE_ALL || right === AGENT_SCOPE_ALL
    ? left === right
    : left.length === right.length && left.every((name, index) => right[index] === name);

export const subagentNames = (definition: Pick<AgentDefinition, "name" | "subagents">, names: string[]) =>
  definition.subagents === AGENT_SCOPE_ALL
    ? names.filter((name) => name !== definition.name)
    : definition.subagents;

export type AgentInternals = {
  thinking?: string;
  prompt: string;
  source: AgentSource;
  path: string;
  relativePath: string;
  fileSkills: Grant;
};

export const isChore = (relativePath: string) => relativePath.split(/[\\/]/).slice(0, -1).includes("chores");

export type AgentDefinition = AgentFrontmatter & AgentInternals;

export type DefinitionError = { path: string; message: string };

export type NewAgent = {
  agent: string;
  description: string;
  callerId: string;
  depth: number;
  batchId: string;
  dir: string;
  contextLimit: number;
  model?: string;
  skills?: string[];
  chainIndex?: number;
  predecessorId?: string;
  worktree?: Worktree;
};

export type AgentRegistry = {
  create(input: NewAgent): AgentRecord;
  restore(records: AgentRecord[]): void;
  get(id: string): AgentRecord | undefined;
  list(): AgentRecord[];
  batch(batchId: string): AgentRecord[];
  update(id: string, patch: Partial<AgentRecord>): AgentRecord;
  close(id: string, patch: Partial<AgentRecord> & { state: AgentState }): AgentRecord;
};

export type AgentDefinitions = {
  get(name: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
  promptAppend(definition: AgentDefinition): string[];
  reload(): void;
};

export type RouteResult =
  | { ok: true; delivery: "steer" | "followUp" | "held" }
  | { ok: false; error: string };

export type AgentRunner = {
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

type FetchToolService = {
  tool(): AnyToolSpec;
};

type AgentViewService = {
  open(id: string): Promise<void>;
};

type AgentSetupService = {
  usage: { setup: string; create: string };
  run(args: string): Promise<void>;
  create(args: string): Promise<void>;
  complete(prefix: string): { value: string; label: string }[];
};

export type ServiceMap = {
  registry: AgentRegistry;
  agentView: AgentViewService;
  agentSetup: AgentSetupService;
  definitions: AgentDefinitions;
  runner: AgentRunner;
  handoff: HandoffService;
  agentStatus: AgentStatusService;
  fetchTool: FetchToolService;
};

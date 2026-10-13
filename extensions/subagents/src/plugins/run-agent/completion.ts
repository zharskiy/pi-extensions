import type { ThemeLike, ThemeToken } from "../../../../../core/adapter/contract.ts";
import { firstLine, formatDuration, SEP, singleLine, truncateCols } from "../../components/format.ts";
import { stateGlyph, stateSentence } from "../../components/state-text.ts";
import type { AgentRecord, WorktreeCleanup } from "../../model/types.ts";

export const CLOSED_ENTRY = "pi-subagents:agent-closed";

type ClosedState = "done" | "failed" | "stopped" | "handoff";

export type ClosedEntry = {
  v: 1;
  id: string;
  agent: string;
  description: string;
  state: ClosedState;
  durationMs: number;
  error?: string;
  sessions?: number;
  worktree?: WorktreeCleanup;
  branch?: string;
};

const DESCRIPTION_COLS = 60;

const ERROR_COLS = 120;

const TOKENS: Record<ClosedState, ThemeToken> = {
  done: "dim",
  failed: "error",
  stopped: "warning",
  handoff: "warning",
};

const CLEANUP_TEXT: Record<WorktreeCleanup, (branch: string) => string> = {
  removed: () => "worktree removed",
  "branch kept": (branch) => `branch ${branch} kept`,
  kept: () => "worktree kept",
};

export const closedEntryOf = (record: AgentRecord, links: AgentRecord[]): ClosedEntry => {
  const first = links[0] ?? record;
  const start = first.startedAt ?? first.createdAt;

  return {
    v: 1,
    id: record.id,
    agent: record.agent,
    description: record.description,
    state: record.state as ClosedState,
    durationMs: Math.max(0, (record.endedAt ?? start) - start),
    error: record.state === "failed" ? firstLine(record.error ?? "unknown error") : undefined,
    sessions: links.length > 1 ? links.length : undefined,
    worktree: record.worktree?.cleanup,
    branch: record.worktree?.branch,
  };
};

const isEntry = (data: unknown): data is ClosedEntry =>
  typeof data === "object" && data !== null && (data as { v?: unknown }).v === 1;

export const renderClosedEntry = (data: unknown, theme: ThemeLike): string[] | undefined => {
  if (!isEntry(data) || !TOKENS[data.state]) {
    return undefined;
  }

  const description = truncateCols(singleLine(data.description), DESCRIPTION_COLS);
  const error = data.state === "failed" ? `: ${truncateCols(data.error ?? "unknown error", ERROR_COLS)}` : "";
  const details = [
    formatDuration(data.durationMs),
    data.sessions ? `${data.sessions} sessions` : undefined,
    data.worktree ? CLEANUP_TEXT[data.worktree](data.branch ?? "") : undefined,
  ].filter((part): part is string => part !== undefined);
  const text = `${stateGlyph(data.state, 0)} Agent "${description}" ${stateSentence(data.state)}${error}${SEP}${details.join(SEP)}`;

  return [theme.fg(TOKENS[data.state], text)];
};

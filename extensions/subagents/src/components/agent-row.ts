import type { ThemeLike, ThemeToken } from "../../../../core/adapter/contract.ts";
import { type AgentRecord, type AgentState, isClosed } from "../model/types.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATE_ICONS: Record<Exclude<AgentState, "running">, string> = {
  queued: "○",
  grace: "◐",
  done: "✓",
  failed: "✗",
  stopped: "■",
  handoff: "↪",
};

const STATE_COLORS: Record<AgentState, ThemeToken> = {
  queued: "muted",
  running: "accent",
  grace: "warning",
  done: "success",
  failed: "error",
  stopped: "muted",
  handoff: "warning",
};

export const formatTokens = (count: number) => {
  if (count < 1_000) {
    return `${count}`;
  }

  if (count < 1_000_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }

  return `${(count / 1_000_000).toFixed(1)}M`;
};

export const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const elapsedOf = (record: AgentRecord, now: number) => {
  const start = record.startedAt ?? record.createdAt;
  const end = record.endedAt ?? now;

  return end - start;
};

export const stateIcon = (state: AgentState, frame: number) => {
  if (state === "running") {
    return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  }

  return STATE_ICONS[state];
};

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const statsText = (record: AgentRecord, now: number) =>
  [
    plural(record.toolCalls, "tool call"),
    `${formatTokens(record.tokens)} tokens`,
    formatElapsed(elapsedOf(record, now)),
  ].join(" · ");

export const finishSummary = (record: AgentRecord, now: number) => {
  const stats = statsText(record, now);

  if (record.state === "done") {
    return `Done (${stats})`;
  }

  if (record.state === "handoff") {
    return `Handoff (${stats})`;
  }

  if (record.state === "stopped") {
    return `Stopped (${stats})`;
  }

  return `Failed: ${record.error ?? "unknown error"} (${stats})`;
};

export const progressText = (record: AgentRecord, now: number) => {
  if (record.state === "queued") {
    return "queued";
  }

  const percent = record.context?.percent;
  const stats = statsText(record, now);

  if (percent === null || percent === undefined) {
    return stats;
  }

  return `${stats} · ${Math.round(percent)}% ctx`;
};

export const truncate = (text: string, width: number) => {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  return `${text.slice(0, Math.max(0, width - 1))}…`;
};

export const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const chainLabel = (record: AgentRecord) => (record.chainIndex > 1 ? ` #${record.chainIndex}` : "");

export const attentionText = (record: AgentRecord) => {
  if (!record.attention || isClosed(record.state)) {
    return undefined;
  }

  return `needs input: ${singleLine(record.attention.title)}`;
};

export const graceSecondsLeft = (record: AgentRecord, now: number) => {
  if (record.state !== "grace" || record.graceEndsAt === undefined) {
    return undefined;
  }

  return Math.max(0, Math.ceil((record.graceEndsAt - now) / 1_000));
};

const graceCountdown = (record: AgentRecord, now: number) => {
  if (record.state !== "grace") {
    return undefined;
  }

  const seconds = graceSecondsLeft(record, now);

  return seconds === undefined ? "stopping · answering" : `stopping in ${seconds}s`;
};

export const agentRow = (
  record: AgentRecord,
  now: number,
  frame: number,
  theme: ThemeLike,
  width: number,
) => {
  const icon = theme.fg(STATE_COLORS[record.state], stateIcon(record.state, frame));
  const detail = isClosed(record.state) ? finishSummary(record, now) : progressText(record, now);
  const description = singleLine(record.description);
  const name = `${record.id}${chainLabel(record)}`;
  const model = record.model ? ` (${record.model})` : "";
  const attention = attentionText(record);
  const alert = attention ? ` · ${attention}` : "";
  const head = `${name}${model} · `;
  const tail = ` · ${detail}`;
  const room = Math.max(8, width - 2 - head.length - tail.length - alert.length);
  const row = `${icon} ${theme.bold(name)}${theme.fg("dim", model)} · ${theme.fg("muted", truncate(description, room))}${theme.fg("dim", tail)}`;

  return attention ? `${row}${theme.fg("warning", alert)}` : row;
};

export const treeRow = (record: AgentRecord, now: number, frame: number, theme: ThemeLike, width: number) => {
  const indent = "  ".repeat(Math.max(0, record.depth - 2));
  const countdown = graceCountdown(record, now);

  if (countdown === undefined) {
    return `${indent}${agentRow(record, now, frame, theme, width - indent.length)}`;
  }

  const suffix = ` · ${countdown}`;
  const row = agentRow(record, now, frame, theme, width - indent.length - suffix.length);

  return `${indent}${row}${theme.fg("warning", suffix)}`;
};

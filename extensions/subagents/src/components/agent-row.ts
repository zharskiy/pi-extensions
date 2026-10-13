import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { type AgentRecord, type AgentState, isClosed } from "../model/types.ts";
import { elapsedOf, formatDuration, formatTokens, singleLine } from "./format.ts";
import { SPINNER_FRAMES } from "./spinner.ts";
import { stateGlyph, stateToken } from "./state-text.ts";

export const stateIcon = (state: AgentState, frame: number) =>
  state === "running" ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : stateGlyph(state, 0);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const statsText = (record: AgentRecord, now: number) =>
  [
    plural(record.toolCalls, "tool call"),
    `${formatTokens(record.tokens)} tokens`,
    formatDuration(elapsedOf(record, now)),
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

export const chainLabel = (record: AgentRecord) => (record.chainIndex > 1 ? ` #${record.chainIndex}` : "");

const graceSecondsLeft = (record: AgentRecord, now: number) => {
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
  const icon = theme.fg(stateToken(record.state), stateIcon(record.state, frame));
  const detail = isClosed(record.state) ? finishSummary(record, now) : progressText(record, now);
  const description = singleLine(record.description);
  const name = `${record.id}${chainLabel(record)}`;
  const model = record.model ? ` (${record.model})` : "";
  const head = `${name}${model} · `;
  const tail = ` · ${detail}`;
  const room = Math.max(8, width - 2 - head.length - tail.length);

  return `${icon} ${theme.bold(name)}${theme.fg("dim", model)} · ${theme.fg("muted", truncate(description, room))}${theme.fg("dim", tail)}`;
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

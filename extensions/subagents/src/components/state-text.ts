import { MARKS, type Mark, markGlyph } from "../../../../core/manager/marks.ts";
import type { ThemeLike, ThemeToken } from "../../../../pi-adapter/index.ts";
import { type AgentRecord, type AgentState, isClosed } from "../model/types.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const spinnerFrame = (now: number): string => SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];

const STATE_MARKS: Record<AgentState, Mark> = {
  queued: "pending",
  running: "pending",
  grace: "pending",
  done: "success",
  failed: "error",
  stopped: "stopped",
  handoff: "stopped",
};

const TOKENS: Record<AgentState, ThemeToken> = {
  queued: "dim",
  running: "accent",
  grace: "dim",
  done: "success",
  failed: "error",
  stopped: "muted",
  handoff: "muted",
};

const WORDS: Record<AgentState, string> = {
  queued: "queued",
  running: "running",
  grace: "stopping",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  handoff: "handed off",
};

const DISPLAY_WORDS: Partial<Record<AgentState, string>> = {
  queued: "Queued",
  grace: "Stopping",
  stopped: "Stopped",
  handoff: "Handed off",
};

const STARTING = "Starting";

export const stateMark = (state: AgentState): Mark => STATE_MARKS[state];

export const stateGlyph = (state: AgentState, now: number): string =>
  state === "running" ? spinnerFrame(now) : MARKS[stateMark(state)];

export const stateToken = (state: AgentState): ThemeToken => TOKENS[state];

export const liveGlyph = (state: AgentState, now: number, theme: ThemeLike): string =>
  theme.fg(stateToken(state), stateGlyph(state, now));

export const scrollGlyph = (state: AgentState, theme: ThemeLike): string =>
  markGlyph(stateMark(state), theme);

export const stateWord = (state: AgentState): string => WORDS[state];

export const isStarting = (record: Pick<AgentRecord, "state" | "turns" | "toolCalls" | "activity">) =>
  record.state === "running" && record.turns === 0 && record.toolCalls === 0 && !record.activity;

export const displayWord = (
  record: Pick<AgentRecord, "state" | "turns" | "toolCalls" | "activity">,
): string | undefined => (isStarting(record) ? STARTING : DISPLAY_WORDS[record.state]);

export const stopWords = (state: AgentState): string =>
  isClosed(state) ? "to clear" : state === "grace" ? "to close now" : "to stop";

import type { ThemeToken } from "../../../../core/adapter/contract.ts";
import type { AgentState } from "../model/types.ts";
import { spinnerFrame } from "./spinner.ts";

const GLYPHS: Record<Exclude<AgentState, "running">, string> = {
  queued: "○",
  grace: "◐",
  done: "✓",
  failed: "✗",
  stopped: "■",
  handoff: "↪",
};

const TOKENS: Record<AgentState, ThemeToken> = {
  queued: "muted",
  running: "accent",
  grace: "warning",
  done: "success",
  failed: "error",
  stopped: "muted",
  handoff: "warning",
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

export const stateGlyph = (state: AgentState, now: number): string =>
  state === "running" ? spinnerFrame(now) : GLYPHS[state];

export const stateToken = (state: AgentState): ThemeToken => TOKENS[state];

export const stateWord = (state: AgentState): string => WORDS[state];

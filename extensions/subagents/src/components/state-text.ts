import type { ThemeToken } from "../../../../core/adapter/contract.ts";
import { type AgentState, isClosed } from "../model/types.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const spinnerFrame = (now: number): string => SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];

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

export const stopHint = (state: AgentState): string =>
  isClosed(state) ? "x to clear" : state === "grace" ? "x to close now" : "x to stop";

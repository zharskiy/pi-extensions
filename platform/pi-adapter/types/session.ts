import type { StopReason } from "./runtime.ts";

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

export type NewSessionOptions = {
  parentSession?: string;
  seed?: { customType: string; text: string; details?: unknown };
};

export type SessionControl = {
  newSession(options: NewSessionOptions): Promise<boolean>;
};

export type Phase = "waiting" | "thinking" | "writing" | "toolArgs" | "tool" | "idle";

export type DialogKind = "select" | "confirm" | "input" | "editor" | "custom";

export type DialogEvent = { phase: "start" | "end"; kind: DialogKind; title?: string };

export type IdleInfo = { aborted: boolean };

export type AssistantEnd = { toolCalls: number; stopReason: StopReason; text: boolean };

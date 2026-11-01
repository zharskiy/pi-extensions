import type { CustomMessage, ImageAttachment, UserMessage } from "./messages.ts";

export type RunMode = "tui" | "rpc" | "print" | "json";

export type SessionInfo = {
  id: string;
  file?: string;
  parentSession?: string;
  created: boolean;
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  subscription: boolean;
  mode: RunMode;
};

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export type NewSessionOptions = {
  parentSession?: string;
  seed?: CustomMessage & { images?: ImageAttachment[] };
  keepSelection?: boolean;
  continueWithSeed?: boolean;
  followUps?: UserMessage[];
  editorText?: string;
};

export type SessionControl = {
  newSession(options: NewSessionOptions): Promise<boolean>;
};

export type Phase = "waiting" | "thinking" | "writing" | "toolArgs" | "tool" | "idle";

export type DialogKind = "select" | "confirm" | "input" | "editor" | "custom";

export type DialogEvent = { phase: "start" | "end"; kind: DialogKind; title?: string };

export type IdleInfo = { aborted: boolean };

type InputSource = "interactive" | "rpc" | "extension";

export type UserInput = UserMessage & { source: InputSource; streaming: boolean };

export type AssistantEnd = { toolCalls: number; final: boolean };

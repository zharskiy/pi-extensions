import type { SessionControl } from "./session.ts";
import type { TranscriptItem } from "./view.ts";

export type CommandSpec = {
  description: string;
  complete?(prefix: string): { value: string; label: string }[] | null;
  run(args: string, control: SessionControl): Promise<void> | void;
};

export type CustomMessage = { customType: string; text: string; details?: unknown };

type ImageAttachment = { data: string; mimeType: string };

export type UserMessage = { text: string; images: ImageAttachment[] };

export type RoutedMessage = { sender: string; text: string };

export type PromptTool = { name: string; description: string; parameters: unknown };

export type SkillInfo = {
  name: string;
  description: string;
  scope: "project" | "user" | "temporary";
  path: string;
};

export type SessionRecord = {
  providerPayload?: unknown;
  items: TranscriptItem[];
  contextTokens?: number;
};

export type CodemodeShortfall = { setting: string; workers: number; wanted: number };

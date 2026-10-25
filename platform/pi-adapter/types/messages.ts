import type { SessionControl } from "./session.ts";
import type { TranscriptItem } from "./view.ts";

export type CommandSpec = {
  description: string;
  complete?(prefix: string): { value: string; label: string }[] | null;
  run(args: string, control: SessionControl): Promise<void> | void;
};

export type HiddenMessage = { customType: string; text: string; details?: unknown };

export type HandoffDelivery = "afterRun" | "afterTurn";

export type HostMessage = { customType: string; text: string; display: boolean; details?: unknown };

export type RoutedMessage = {
  sender: string;
  text: string;
  custom?: { customType: string; details?: unknown };
  after?: HandoffDelivery;
};

export type ChildSeed = { customType: string; text: string; details?: unknown };

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

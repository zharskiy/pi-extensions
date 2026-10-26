import type { ContextSnapshot } from "./context.ts";
import type {
  CodemodeShortfall,
  CustomMessage,
  RoutedMessage,
  SessionRecord,
  SkillInfo,
} from "./messages.ts";
import type { AvailableModel, ModelResolution } from "./model.ts";
import type { AnyToolSpec } from "./tools.ts";
import type { UsageTotals } from "./usage.ts";

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "deferred";

export type ChildEvent =
  | { type: "turn_end"; context: ContextSnapshot }
  | {
      type: "assistant_message";
      text: string;
      stopReason: StopReason;
      toolCalls: number;
      errorMessage?: string;
    }
  | { type: "tool_start"; toolName: string }
  | { type: "settled"; aborted: boolean };

export type MessageDelivery = "steer" | "followUp";

export type ChildSession = {
  readonly id: string;
  readonly sessionFile: string | undefined;
  start(task: string, seed?: CustomMessage): void;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  send(message: RoutedMessage, delivery: MessageDelivery): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  ownUsage(): UsageTotals;
  lastText(): string;
  runTexts(): string[];
  wake(text: string): Promise<void>;
};

export type SpawnSpec = {
  id: string;
  cwd: string;
  sessionDir: string;
  parentSessionFile?: string;
  model: string;
  thinking: string;
  tools?: string[];
  skills: string[];
  mcp?: boolean;
  promptAppend: string[];
  reserveTokens: number;
  customTools: AnyToolSpec[];
};

export type AgentRuntime = {
  spawn(spec: SpawnSpec): Promise<ChildSession>;
  readSession(file: string): SessionRecord;
  resolveModel(request: string | undefined): ModelResolution;
  availableModels(): AvailableModel[];
  defaultThinking(): string;
  skillCatalog(): SkillInfo[];
  skillNames(): string[];
  sessionSkillNames(): string[];
  reserveCodemodeWorkers(agentSessions: number): CodemodeShortfall | undefined;
};

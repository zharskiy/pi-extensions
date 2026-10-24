export type RunEvent =
  | { type: "message"; role: string; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "tool_result"; name: string; text: string; isError: boolean };

export type RunRecord = {
  output: string;
  events: RunEvent[];
  usage: { inputTokens: number; outputTokens: number; toolCalls: number; costUsd?: number };
  timings: { totalMs: number };
  errors: string[];
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

export const splitModelRequest = (request: string): { name: string; thinking?: string; error?: string } => {
  const trimmed = request.trim();
  const colon = trimmed.lastIndexOf(":");

  if (colon < 0) {
    return { name: trimmed };
  }

  const suffix = trimmed.slice(colon + 1).toLowerCase();
  const name = trimmed.slice(0, colon).trim();

  if (isThinkingLevel(suffix)) {
    return { name, thinking: suffix };
  }

  if (/^[a-z]+$/.test(suffix)) {
    return {
      name,
      error: `invalid thinking level "${suffix}" in "${trimmed}"; use one of ${THINKING_LEVELS.join(", ")}`,
    };
  }

  return { name: trimmed };
};

export type ModelChoice = {
  ref: string;
  contextWindow: number;
  cost: { input: number; output: number };
};

export type ModelResolution =
  | { kind: "resolved"; request: string; model: ModelChoice }
  | { kind: "ambiguous"; request: string; candidates: ModelChoice[] }
  | {
      kind: "unknown";
      request: string;
      candidates: ModelChoice[];
      withoutCredentials: ModelChoice[];
    }
  | { kind: "invalid"; request: string; error: string };

export type AvailableModel = ModelChoice & { thinking: string[] };

export type ModelInfo = { name: string; contextWindow: number; reasoning: boolean };

export const KEPT_RULE_ENTRY = "pi-session-limits:kept-rule";

export const KEPT_MESSAGE_ENTRY = "pi-session-limits:kept-message";

const RULE_STATES = ["kept", "waiting", "editor", "editor-waiting", "returned"] as const;

export type KeptRule = { state: (typeof RULE_STATES)[number] };

export type KeptMessage = { text: string; images: number };

const KEPT_RULES = {
  kept: { idle: "kept", waiting: "waiting" },
  editor: { idle: "editor", waiting: "editor-waiting" },
} as const;

export const keptRuleFor = (editor: boolean, waiting: boolean): KeptRule["state"] =>
  KEPT_RULES[editor ? "editor" : "kept"][waiting ? "waiting" : "idle"];

export const parseKeptRule = (data: unknown): KeptRule | undefined => {
  const state = (data as { state?: unknown } | null)?.state;
  const known = RULE_STATES.find((value) => value === state);

  return known ? { state: known } : undefined;
};

export const parseKeptMessage = (data: unknown): KeptMessage | undefined => {
  const { text, images } = (data ?? {}) as { text?: unknown; images?: unknown };

  return typeof text === "string" && typeof images === "number" ? { text, images } : undefined;
};

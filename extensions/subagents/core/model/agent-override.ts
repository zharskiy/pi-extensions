import { isThinkingLevel, THINKING_LEVELS } from "../../../../platform/pi-adapter/index.ts";
import type { AgentOverride } from "./agent-schema.ts";
import { checkGrant, checkModel } from "./agent-values.ts";

export type OverrideField = { patch: AgentOverride; error?: string };

export const OVERRIDE_FIELDS = ["model", "thinking", "skills"] as const;

type OverrideKey = (typeof OVERRIDE_FIELDS)[number];

const CHORE_FIELDS = OVERRIDE_FIELDS.filter((field) => field !== "skills");

export const editableFields = (chore: boolean): readonly OverrideKey[] =>
  chore ? CHORE_FIELDS : OVERRIDE_FIELDS;

export const overrideModel = (value: unknown): OverrideField => {
  const { error, ...patch } = checkModel(value);

  return { patch, error };
};

export const overrideThinking = (value: unknown): OverrideField =>
  typeof value === "string" && isThinkingLevel(value)
    ? { patch: { thinking: value } }
    : { patch: {}, error: `thinking must be one of ${THINKING_LEVELS.join(", ")}` };

export const overrideSkills = (value: unknown): OverrideField => {
  const { grant, error, warning } = checkGrant("skills", value);

  return grant === undefined ? { patch: {}, error } : { patch: { skills: grant }, error: warning };
};

export const unknownSkillsProblem = (skills: string[], loaded: string[]) => {
  const unknownSkills = skills.filter((skill) => !loaded.includes(skill));
  const available = loaded.length > 0 ? loaded.join(", ") : "none";

  return unknownSkills.length > 0
    ? `names unknown skill(s) ${unknownSkills.join(", ")} (available skills: ${available})`
    : undefined;
};

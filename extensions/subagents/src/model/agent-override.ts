import { splitModelRequest, THINKING_LEVELS } from "../../../../pi-adapter/index.ts";
import { type AgentOverride, ALL, INHERIT_MODEL } from "./agent-schema.ts";

export type OverrideField = { patch: AgentOverride; error?: string };

export const OVERRIDE_FIELDS = ["model", "thinking", "skills"] as const;

const MODEL_FORMAT = `provider/id[:thinking] or ${INHERIT_MODEL}, without spaces`;

export const overrideModel = (value: unknown): OverrideField => {
  const text = typeof value === "string" ? value.trim() : "";

  if (text.length === 0 || /\s/.test(text)) {
    return { patch: {}, error: `model must be ${MODEL_FORMAT}` };
  }

  const request = splitModelRequest(text);

  if (request.error) {
    return { patch: {}, error: `model: ${request.error}` };
  }

  const thinking = request.thinking ? { thinking: request.thinking } : {};

  return request.name.length === 0 ? { patch: thinking } : { patch: { model: request.name, ...thinking } };
};

export const overrideThinking = (value: unknown): OverrideField =>
  typeof value === "string" && THINKING_LEVELS.includes(value)
    ? { patch: { thinking: value } }
    : { patch: {}, error: `thinking must be one of ${THINKING_LEVELS.join(", ")}` };

export const overrideSkills = (value: unknown): OverrideField => {
  if (value === ALL) {
    return { patch: { skills: ALL } };
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return { patch: { skills: Array.from(new Set(value.map((entry: string) => entry.trim()))) } };
  }

  return { patch: {}, error: `skills must be "${ALL}" or a list of skill names` };
};

export const unknownSkillsProblem = (skills: string[], loaded: string[]) => {
  const unknownSkills = skills.filter((skill) => !loaded.includes(skill));
  const available = loaded.length > 0 ? loaded.join(", ") : "none";

  return unknownSkills.length > 0
    ? `names unknown skill(s) ${unknownSkills.join(", ")} (available skills: ${available})`
    : undefined;
};

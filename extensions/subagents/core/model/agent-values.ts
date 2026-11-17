import { splitModelRequest } from "../../../../platform/pi-adapter/index.ts";
import {
  AGENT_SCOPE_ALL,
  type Grant,
  INHERIT_MODEL,
  PLAIN_NAME,
  PLAIN_NAME_TEXT,
  SKILL_NAME,
  SKILL_NAME_TEXT,
} from "./agent-schema.ts";

type ModelCheck = { model?: string; thinking?: string; error?: string };

type GrantCheck = { grant: Grant; error?: string; warning?: string };

const MODEL_FORMAT = `[provider/]id[:thinking] or ${INHERIT_MODEL}[:thinking], without spaces`;

export const checkModel = (value: unknown): ModelCheck => {
  const text = typeof value === "string" ? value.trim() : "";

  if (text.length === 0 || /\s/.test(text)) {
    return { error: `model must be ${MODEL_FORMAT}` };
  }

  const request = splitModelRequest(text);

  if (request.error) {
    return { error: `model: ${request.error}` };
  }

  const thinking = request.thinking ? { thinking: request.thinking } : {};

  return request.name.length === 0 ? thinking : { model: request.name, ...thinking };
};

const namesOf = (value: unknown) => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }

  const strings = Array.isArray(value) && value.every((entry) => typeof entry === "string");

  return strings ? value.map((name: string) => name.trim()) : undefined;
};

const NAME_RULES: Record<string, { pattern: RegExp; text: string }> = {
  skills: { pattern: SKILL_NAME, text: SKILL_NAME_TEXT },
};

const PLAIN_RULE = { pattern: PLAIN_NAME, text: `plain names of ${PLAIN_NAME_TEXT}` };

const nameRule = (key: string) => NAME_RULES[key] ?? PLAIN_RULE;

const isGrantName = (key: string, name: string) =>
  name.toLowerCase() !== AGENT_SCOPE_ALL && nameRule(key).pattern.test(name);

const grantProblems = (key: string, names: string[]) => {
  const misspelled = names.filter(
    (name) => name !== AGENT_SCOPE_ALL && name.toLowerCase() === AGENT_SCOPE_ALL,
  );
  const invalid = names.filter((name) => name.toLowerCase() !== AGENT_SCOPE_ALL && !isGrantName(key, name));

  return [
    misspelled.length > 0
      ? `${key} takes ${AGENT_SCOPE_ALL} in lowercase, got: ${misspelled.join(", ")}`
      : "",
    names.includes(AGENT_SCOPE_ALL)
      ? `${key} must be ${AGENT_SCOPE_ALL} on its own or a list of names, got: ${names.join(", ")}`
      : "",
    invalid.length > 0 ? `${key} entries must be ${nameRule(key).text}, got: ${invalid.join(", ")}` : "",
  ].filter(Boolean);
};

export const checkGrant = (key: string, value: unknown): GrantCheck => {
  const names = namesOf(value);

  if (!names) {
    return {
      grant: [],
      error: `${key} must be ${AGENT_SCOPE_ALL} or a list of names, as a list or a comma-separated string`,
    };
  }

  if (names.length === 1 && names[0] === AGENT_SCOPE_ALL) {
    return { grant: AGENT_SCOPE_ALL };
  }

  const problems = grantProblems(key, names);
  const valid = names.filter((name) => isGrantName(key, name));
  const grant = Array.from(new Set(valid));
  const duplicates = Array.from(new Set(valid.filter((name, index) => valid.indexOf(name) !== index)));
  const warning =
    duplicates.length > 0 ? `${key} lists entries more than once: ${duplicates.join(", ")}` : undefined;
  const error = problems.length > 0 ? problems.join("; ") : undefined;

  return { grant, ...(error ? { error } : {}), ...(warning ? { warning } : {}) };
};

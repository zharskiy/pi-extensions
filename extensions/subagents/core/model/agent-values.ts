import { splitModelRequest } from "../../../../platform/pi-adapter/index.ts";
import { AGENT_SCOPE_ALL, type Grant, INHERIT_MODEL, PLAIN_NAME, PLAIN_NAME_TEXT } from "./agent-schema.ts";

type ModelCheck = { model?: string; thinking?: string; error?: string };

type GrantCheck = { grant?: Grant; error?: string; warning?: string };

const MODEL_FORMAT = `provider/id[:thinking] or ${INHERIT_MODEL}, without spaces`;

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

export const checkGrant = (key: string, value: unknown): GrantCheck => {
  const names = namesOf(value);

  if (!names) {
    return {
      error: `${key} must be ${AGENT_SCOPE_ALL} or a list of names, as a list or a comma-separated string`,
    };
  }

  const misspelled = names.filter(
    (name) => name !== AGENT_SCOPE_ALL && name.toLowerCase() === AGENT_SCOPE_ALL,
  );

  if (misspelled.length > 0) {
    return { error: `${key} takes ${AGENT_SCOPE_ALL} in lowercase, got: ${misspelled.join(", ")}` };
  }

  if (names.includes(AGENT_SCOPE_ALL)) {
    return names.length > 1
      ? { error: `${key} must be ${AGENT_SCOPE_ALL} on its own or a list of names, got: ${names.join(", ")}` }
      : { grant: AGENT_SCOPE_ALL };
  }

  const invalid = names.filter((name) => !PLAIN_NAME.test(name));

  if (invalid.length > 0) {
    return { error: `${key} entries must be plain names of ${PLAIN_NAME_TEXT}, got: ${invalid.join(", ")}` };
  }

  const grant = Array.from(new Set(names));
  const duplicates = Array.from(new Set(names.filter((name, index) => names.indexOf(name) !== index)));

  if (duplicates.length > 0) {
    return { grant, warning: `${key} lists entries more than once: ${duplicates.join(", ")}` };
  }

  return { grant };
};

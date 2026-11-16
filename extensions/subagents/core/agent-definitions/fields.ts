import type { FrontmatterValue } from "../../../../platform/shared/index.ts";
import {
  type AgentFrontmatter,
  ALL_SKILLS_TEXT,
  INHERIT_MODEL,
  PLAIN_NAME,
  PLAIN_NAME_TEXT,
} from "../model/agent-schema.ts";
import { checkGrant, checkModel } from "../model/agent-values.ts";

type FieldKey = keyof AgentFrontmatter;

type FieldKind = "name" | "text" | "model" | "integer" | "list" | "switch";

type FieldRule = {
  kind: FieldKind;
  required: boolean;
  hint?: string;
  namesMeaning?: string;
  allMeaning?: string;
  min?: number;
};

type FieldSpec = FieldRule & { key: FieldKey };

type FieldResult = { value?: unknown; thinking?: string; error?: string; warning?: string };

const RULES: { [K in FieldKey]: FieldRule } = {
  name: { kind: "name", required: true },
  description: { kind: "text", required: true },
  model: { kind: "model", required: false },
  limit: {
    kind: "integer",
    required: true,
    min: 5_000,
    hint: "context limit in tokens, for example limit: 100000",
  },
  tools: {
    kind: "list",
    required: true,
    namesMeaning: "tool names",
    allMeaning: "the tools active in the main session",
  },
  skills: {
    kind: "list",
    required: true,
    namesMeaning: "skill names",
    allMeaning: ALL_SKILLS_TEXT,
  },
  subagents: {
    kind: "list",
    required: true,
    namesMeaning: "agent names it may start",
    allMeaning: "every other agent",
  },
  worktree: { kind: "switch", required: false },
  mcp: { kind: "switch", required: false },
};

export const FRONTMATTER_FIELDS: readonly FieldSpec[] = Object.entries(RULES).map(([key, rule]) => ({
  key: key as FieldKey,
  ...rule,
}));

const missingFieldMessage = (spec: FieldSpec) => {
  const hint =
    spec.kind === "list" ? `${spec.namesMeaning}, all for ${spec.allMeaning}, or [] for none` : spec.hint;

  return hint ? `${spec.key} is required (${hint})` : `${spec.key} is required`;
};

type FieldParser = (spec: FieldSpec, value: FrontmatterValue) => FieldResult;

const textField: FieldParser = (spec, value) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${spec.key} must be a non-empty string` };
  }

  return { value: value.trim() };
};

const nameField: FieldParser = (spec, value) => {
  const field = textField(spec, value);

  if (typeof field.value === "string" && !PLAIN_NAME.test(field.value)) {
    return { error: `${spec.key} must be a plain name of ${PLAIN_NAME_TEXT}` };
  }

  return field;
};

const modelField: FieldParser = (_spec, value) => {
  const { model, thinking, error } = checkModel(value);

  if (error) {
    return { error };
  }

  return { value: model === INHERIT_MODEL ? undefined : model, thinking };
};

const integerField: FieldParser = (spec, value) => {
  const min = spec.min ?? 0;

  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    return { error: `${spec.key} must be an integer of at least ${min}` };
  }

  return { value };
};

const listField: FieldParser = (spec, value) => {
  const { grant, error, warning } = checkGrant(spec.key, value);

  return { value: grant, error, warning };
};

const switchField: FieldParser = (spec, value) =>
  typeof value === "boolean" ? { value } : { error: `${spec.key} must be true or false` };

const PARSERS: Record<FieldKind, FieldParser> = {
  name: nameField,
  text: textField,
  model: modelField,
  integer: integerField,
  list: listField,
  switch: switchField,
};

export const readField = (spec: FieldSpec, value: FrontmatterValue | undefined): FieldResult => {
  if (value === undefined) {
    return spec.required ? { error: missingFieldMessage(spec) } : {};
  }

  return PARSERS[spec.kind](spec, value);
};

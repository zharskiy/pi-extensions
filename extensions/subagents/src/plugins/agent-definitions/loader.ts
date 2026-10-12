import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitModelRequest } from "../../../../../core/adapter/contract.ts";
import {
  type AgentFrontmatter,
  ALL,
  type FieldKind,
  type FieldSpec,
  FRONTMATTER_FIELDS,
  INHERIT_MODEL,
  missingFieldMessage,
} from "../../model/frontmatter.ts";
import {
  type AgentDefinition,
  type AgentSource,
  type DefinitionError,
  subagentNames,
} from "../../model/types.ts";
import { type FrontmatterValue, parseFrontmatter, parseScalar } from "./frontmatter.ts";

export type DefinitionDir = { path: string; source: AgentSource };

export type LoadResult = {
  definitions: Map<string, AgentDefinition>;
  errors: DefinitionError[];
  warnings: DefinitionError[];
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

type FieldResult = { value?: unknown; thinking?: string; error?: string; warning?: string };

type FieldParser = (spec: FieldSpec, value: FrontmatterValue) => FieldResult;

const textField: FieldParser = (spec, value) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${spec.key} must be a non-empty string` };
  }

  return { value: value.trim() };
};

const nameField: FieldParser = (spec, value) => {
  const field = textField(spec, value);

  if (typeof field.value === "string" && !NAME_PATTERN.test(field.value)) {
    return { error: `${spec.key} may only contain letters, digits, '-' and '_'` };
  }

  return field;
};

const modelField: FieldParser = (spec, value) => {
  const field = textField(spec, value);

  if (typeof field.value !== "string") {
    return field;
  }

  if (/\s/.test(field.value)) {
    return { error: `${spec.key} must be name[:thinking] without spaces, got "${field.value}"` };
  }

  const request = splitModelRequest(field.value);

  if (request.error) {
    return { error: `${spec.key}: ${request.error}` };
  }

  if (request.name.length === 0 || request.name === INHERIT_MODEL) {
    return { thinking: request.thinking };
  }

  return { value: request.name, thinking: request.thinking };
};

const integerField: FieldParser = (spec, value) => {
  const min = spec.min ?? 0;

  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    return { error: `${spec.key} must be an integer of at least ${min}` };
  }

  return { value };
};

const listOf = (value: FrontmatterValue) => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return Array.isArray(value) ? value : undefined;
};

const entryErrors = (spec: FieldSpec, names: string[]) => {
  const invalid = spec.entry ? names.filter((name) => !spec.entry?.pattern.test(name)) : [];

  return invalid.length > 0
    ? `${spec.key} entries must be ${spec.entry?.text}, got: ${invalid.join(", ")}`
    : undefined;
};

const listField: FieldParser = (spec, value) => {
  const names = listOf(value);

  if (!names) {
    return { error: `${spec.key} must be a list or a comma-separated string` };
  }

  const misspelled = names.filter((name) => name !== ALL && name.toLowerCase() === ALL);

  if (misspelled.length > 0) {
    return { error: `${spec.key} takes all in lowercase, got: ${misspelled.join(", ")}` };
  }

  if (names.includes(ALL)) {
    return names.length > 1
      ? { error: `${spec.key} must be all on its own or a list of names, got: ${names.join(", ")}` }
      : { value: ALL };
  }

  const invalid = entryErrors(spec, names);

  if (invalid) {
    return { error: invalid };
  }

  const unique = Array.from(new Set(names));
  const duplicates = Array.from(new Set(names.filter((name, index) => names.indexOf(name) !== index)));

  if (duplicates.length > 0) {
    return { value: unique, warning: `${spec.key} lists entries more than once: ${duplicates.join(", ")}` };
  }

  return { value: unique };
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

const readField = (spec: FieldSpec, raw: FrontmatterValue | undefined): FieldResult => {
  const value = raw ?? (spec.byDefault === undefined ? undefined : parseScalar(spec.byDefault));

  if (value === undefined) {
    return spec.required ? { error: missingFieldMessage(spec) } : {};
  }

  return PARSERS[spec.kind](spec, value);
};

const REMOVED_THINKING_FIELD =
  "thinking is no longer a field; put the level on the model as a suffix, for example model: openai/gpt-6-luna:high";

const definedText = (values: (string | undefined)[]) =>
  values.filter((value): value is string => value !== undefined);

export const parseDefinition = (
  source: string,
  path: string,
  origin: AgentSource,
): { definition?: AgentDefinition; errors: string[]; warnings: string[] } => {
  const { data, body } = parseFrontmatter(source);
  const results = FRONTMATTER_FIELDS.map((spec) => ({ spec, result: readField(spec, data[spec.key]) }));

  const errors = definedText(results.map(({ result }) => result.error));
  const warnings = definedText(results.map(({ result }) => result.warning));

  if (data.thinking !== undefined) {
    errors.push(REMOVED_THINKING_FIELD);
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  const frontmatter = Object.fromEntries(
    results.map(({ spec, result }) => [spec.key, result.value]),
  ) as AgentFrontmatter;
  const thinking = results.find(({ spec }) => spec.kind === "model")?.result.thinking;

  return { errors, warnings, definition: { ...frontmatter, thinking, prompt: body, source: origin, path } };
};

const referenceErrors = (definitions: Map<string, AgentDefinition>): DefinitionError[] => {
  const errors: DefinitionError[] = [];

  definitions.forEach((definition) => {
    const listed = definition.subagents === ALL ? [] : definition.subagents;
    const unknown = listed.filter((name) => name !== definition.name && !definitions.has(name));

    if (listed.includes(definition.name)) {
      errors.push({ path: definition.path, message: "subagents must not include the agent itself" });
    }

    if (unknown.length > 0) {
      errors.push({
        path: definition.path,
        message: `subagents names unknown or invalid agent(s): ${unknown.join(", ")}`,
      });
    }
  });

  return errors;
};

const childrenOf = (definitions: Map<string, AgentDefinition>, name: string) => {
  const definition = definitions.get(name);

  return definition ? subagentNames(definition, Array.from(definitions.keys())) : [];
};

const ALL_IN_CYCLE =
  "subagents: all reaches every other agent, so no agent it can reach may start it; list names instead";

const cycleMessage = (definitions: Map<string, AgentDefinition>, cycle: string[]) => {
  const text = `subagents form a cycle: ${cycle.join(" -> ")}`;
  const viaAll = cycle.some((name) => definitions.get(name)?.subagents === ALL);

  return viaAll ? `${text}; ${ALL_IN_CYCLE}` : text;
};

const findCycle = (definitions: Map<string, AgentDefinition>, start: string): string[] | undefined => {
  const visited = new Set<string>();

  const walk = (name: string, path: string[]): string[] | undefined => {
    const children = childrenOf(definitions, name);

    if (children.includes(start)) {
      return [...path, start];
    }

    visited.add(name);

    return children
      .filter((child) => !visited.has(child))
      .reduce<string[] | undefined>((found, child) => found ?? walk(child, [...path, child]), undefined);
  };

  return walk(start, [start]);
};

const cycleErrors = (definitions: Map<string, AgentDefinition>): DefinitionError[] => {
  const errors: DefinitionError[] = [];

  definitions.forEach((definition) => {
    const cycle = findCycle(definitions, definition.name);

    if (cycle) {
      errors.push({ path: definition.path, message: cycleMessage(definitions, cycle) });
    }
  });

  return errors;
};

const pruneSubagentGraph = (definitions: Map<string, AgentDefinition>, errors: DefinitionError[]) => {
  const references = referenceErrors(definitions);
  const found = references.length > 0 ? references : cycleErrors(definitions);

  if (found.length === 0) {
    return;
  }

  const invalidPaths = new Set(found.map((error) => error.path));

  definitions.forEach((definition, name) => {
    if (invalidPaths.has(definition.path)) {
      definitions.delete(name);
    }
  });

  errors.push(...found);
  pruneSubagentGraph(definitions, errors);
};

const markdownFiles = (dir: string) => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => join(dir, file));
};

export const loadDefinitions = (dirs: DefinitionDir[]): LoadResult => {
  const definitions = new Map<string, AgentDefinition>();
  const errors: DefinitionError[] = [];
  const warnings: DefinitionError[] = [];

  dirs.forEach((dir) => {
    markdownFiles(dir.path).forEach((path) => {
      const parsed = parseDefinition(readFileSync(path, "utf8"), path, dir.source);

      if (!parsed.definition) {
        errors.push({ path, message: parsed.errors.join("; ") });
        return;
      }

      definitions.set(parsed.definition.name, parsed.definition);

      parsed.warnings.forEach((message) => {
        warnings.push({ path, message });
      });
    });
  });

  pruneSubagentGraph(definitions, errors);

  return { definitions, errors, warnings };
};

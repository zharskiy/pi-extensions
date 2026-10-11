import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitModelRequest } from "../../../../../core/adapter/contract.ts";
import type { AgentDefinition, AgentSource, DefinitionError } from "../../model/types.ts";
import { type FrontmatterValue, parseFrontmatter } from "./frontmatter.ts";

export type DefinitionDir = { path: string; source: AgentSource };

export type LoadResult = { definitions: Map<string, AgentDefinition>; errors: DefinitionError[] };

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

type FieldResult<T> = { value?: T; error?: string };

const stringField = (value: FrontmatterValue | undefined, key: string): FieldResult<string> => {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${key} must be a non-empty string` };
  }

  return { value: value.trim() };
};

const listField = (value: FrontmatterValue | undefined, key: string): FieldResult<string[]> => {
  if (value === undefined) {
    return {};
  }

  if (typeof value === "string") {
    return {
      value: value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }

  if (Array.isArray(value)) {
    return { value };
  }

  return { error: `${key} must be a list or a comma-separated string` };
};

const integerField = (value: FrontmatterValue | undefined, key: string, min: number): FieldResult<number> => {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    return { error: `${key} must be an integer of at least ${min}` };
  }

  return { value };
};

const choiceField = <T extends string>(
  value: FrontmatterValue | undefined,
  key: string,
  choices: readonly T[],
  fallback: T,
): FieldResult<T> => {
  if (value === undefined) {
    return { value: fallback };
  }

  if (typeof value !== "string" || !choices.includes(value as T)) {
    return { error: `${key} must be one of ${choices.join(", ")}` };
  }

  return { value: value as T };
};

const booleanField = (value: FrontmatterValue | undefined, key: string): FieldResult<boolean> => {
  if (value === undefined) {
    return { value: false };
  }

  if (typeof value !== "boolean") {
    return { error: `${key} must be true or false` };
  }

  return { value };
};

const INHERIT_MODEL = "inherit";

type ModelField = { model?: string; thinking?: string; error?: string };

const modelField = (value: FrontmatterValue | undefined): ModelField => {
  const field = stringField(value, "model");

  if (field.error || !field.value) {
    return { error: field.error };
  }

  if (/\s/.test(field.value)) {
    return { error: `model must be name[:thinking] without spaces, got "${field.value}"` };
  }

  const request = splitModelRequest(field.value);

  if (request.error) {
    return { error: `model: ${request.error}` };
  }

  if (request.name.length === 0 || request.name === INHERIT_MODEL) {
    return { thinking: request.thinking };
  }

  return { model: request.name, thinking: request.thinking };
};

const REMOVED_THINKING_FIELD =
  "thinking is no longer a field; put the level on the model as a suffix, for example model: openai/gpt-6-luna:high";

export const MIN_LIMIT = 5_000;

export const parseDefinition = (
  source: string,
  path: string,
  origin: AgentSource,
): { definition?: AgentDefinition; errors: string[] } => {
  const { data, body } = parseFrontmatter(source);
  const name = stringField(data.name, "name");
  const description = stringField(data.description, "description");
  const model = modelField(data.model);
  const prompt = stringField(data.prompt, "prompt");
  const tools = listField(data.tools, "tools");
  const skills = listField(data.skills, "skills");
  const subagents = listField(data.subagents, "subagents");
  const input = choiceField(data.input, "input", ["task", "files"] as const, "task");
  const output = choiceField(data.output, "output", ["text", "file"] as const, "text");
  const maxTurns = integerField(data.maxTurns ?? data.max_turns, "maxTurns", 1);
  const limit = integerField(data.limit, "limit", MIN_LIMIT);
  const fallback = booleanField(data.fallback, "fallback");

  const fields = [
    name,
    description,
    model,
    prompt,
    tools,
    skills,
    subagents,
    input,
    output,
    maxTurns,
    limit,
    fallback,
  ];

  const errors = fields.map((field) => field.error).filter((error): error is string => error !== undefined);

  if (data.thinking !== undefined) {
    errors.push(REMOVED_THINKING_FIELD);
  }

  if (!name.value) {
    errors.push("name is required");
  }

  if (!description.value) {
    errors.push("description is required");
  }

  if (data.limit === undefined) {
    errors.push("limit is required (context token budget, for example limit: 100000)");
  }

  if (data.subagents === undefined) {
    errors.push("subagents is required (agent names it may spawn, or [] for none)");
  }

  if (name.value && !NAME_PATTERN.test(name.value)) {
    errors.push("name may only contain letters, digits, '-' and '_'");
  }

  if (errors.length > 0 || !name.value || !description.value || !limit.value || !subagents.value) {
    return { errors };
  }

  const promptText = [body, prompt.value].filter(Boolean).join("\n\n");

  return {
    errors,
    definition: {
      name: name.value,
      description: description.value,
      model: model.model,
      thinking: model.thinking,
      tools: tools.value,
      skills: skills.value,
      prompt: promptText,
      input: input.value ?? "task",
      output: output.value ?? "text",
      maxTurns: maxTurns.value,
      limit: limit.value,
      subagents: Array.from(new Set(subagents.value)),
      fallback: fallback.value ?? false,
      source: origin,
      path,
    },
  };
};

const referenceErrors = (definitions: Map<string, AgentDefinition>): DefinitionError[] => {
  const errors: DefinitionError[] = [];

  definitions.forEach((definition) => {
    const unknown = definition.subagents.filter((name) => name !== definition.name && !definitions.has(name));

    if (definition.subagents.includes(definition.name)) {
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

const findCycle = (definitions: Map<string, AgentDefinition>, start: string): string[] | undefined => {
  const visited = new Set<string>();

  const walk = (name: string, path: string[]): string[] | undefined => {
    const children = definitions.get(name)?.subagents ?? [];

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
      errors.push({ path: definition.path, message: `subagents form a cycle: ${cycle.join(" -> ")}` });
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

  dirs.forEach((dir) => {
    markdownFiles(dir.path).forEach((path) => {
      const parsed = parseDefinition(readFileSync(path, "utf8"), path, dir.source);

      if (!parsed.definition) {
        errors.push({ path, message: parsed.errors.join("; ") });
        return;
      }

      definitions.set(parsed.definition.name, parsed.definition);
    });
  });

  pruneSubagentGraph(definitions, errors);

  return { definitions, errors };
};

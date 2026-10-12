import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentFrontmatter, ALL } from "../../model/agent-schema.ts";
import {
  type AgentDefinition,
  type AgentSource,
  type DefinitionError,
  subagentNames,
} from "../../model/types.ts";
import { FRONTMATTER_FIELDS, readField } from "./fields.ts";
import { parseFrontmatter } from "./yaml-lite.ts";

export type DefinitionDir = { path: string; source: AgentSource };

type LoadResult = {
  definitions: Map<string, AgentDefinition>;
  errors: DefinitionError[];
  warnings: DefinitionError[];
};

const FIELD_KEYS: ReadonlySet<string> = new Set(FRONTMATTER_FIELDS.map((spec) => spec.key));

const definedText = (values: (string | undefined)[]) =>
  values.filter((value): value is string => value !== undefined);

export const parseDefinition = (
  source: string,
  path: string,
  origin: AgentSource,
): { definition?: AgentDefinition; errors: string[]; warnings: string[] } => {
  const { data, body } = parseFrontmatter(source);
  const results = FRONTMATTER_FIELDS.map((spec) => ({ spec, result: readField(spec, data[spec.key]) }));
  const unknown = Object.keys(data).filter((key) => !FIELD_KEYS.has(key));

  const errors = definedText(results.map(({ result }) => result.error));
  const warnings = definedText(results.map(({ result }) => result.warning));

  if (unknown.length > 0) {
    warnings.push(`unknown field(s) ignored: ${unknown.join(", ")}`);
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

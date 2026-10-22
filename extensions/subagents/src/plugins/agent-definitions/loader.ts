import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unknownSkillsProblem } from "../../model/agent-override.ts";
import {
  type AgentFrontmatter,
  type AgentOverride,
  type AgentOverrides,
  ALL,
  INHERIT_MODEL,
} from "../../model/agent-schema.ts";
import {
  type AgentDefinition,
  type AgentSource,
  type DefinitionError,
  subagentNames,
} from "../../model/types.ts";
import { FRONTMATTER_FIELDS, readField } from "./fields.ts";
import { parseFrontmatter } from "./yaml-lite.ts";

export type DefinitionDir = { path: string; source: AgentSource };

type OverrideNotice = { level: "warning" | "info"; message: string };

export type OverrideCheck = {
  overrides: AgentOverrides;
  skillNames: () => string[];
  modelProblem: (model: string) => string | undefined;
  untrustedDir?: string;
};

type LoadResult = {
  definitions: Map<string, AgentDefinition>;
  errors: DefinitionError[];
  warnings: DefinitionError[];
  notices: OverrideNotice[];
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
  const unknownFields = Object.keys(data).filter((key) => !FIELD_KEYS.has(key));

  const errors = definedText(results.map(({ result }) => result.error));
  const warnings = definedText(results.map(({ result }) => result.warning));

  if (unknownFields.length > 0) {
    warnings.push(`unknown field(s) ignored: ${unknownFields.join(", ")}`);
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
    const unknownAgents = listed.filter((name) => name !== definition.name && !definitions.has(name));

    if (listed.includes(definition.name)) {
      errors.push({ path: definition.path, message: "subagents must not include the agent itself" });
    }

    if (unknownAgents.length > 0) {
      errors.push({
        path: definition.path,
        message: `subagents names unknown or invalid agent(s): ${unknownAgents.join(", ")}`,
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

const markdownFiles = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return markdownFiles(path);
      }

      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    });
};

const agentNamesIn = (dir: string) =>
  new Set(
    markdownFiles(dir)
      .map((path) => parseFrontmatter(readFileSync(path, "utf8")).data.name)
      .filter((name): name is string => typeof name === "string"),
  );

const modelNotice = (name: string, model: string | undefined, check: OverrideCheck) => {
  const problem = model === undefined || model === INHERIT_MODEL ? undefined : check.modelProblem(model);

  return problem ? `agents.${name}.model "${model}": ${problem}; dropped` : undefined;
};

const skillsNotice = (name: string, skills: AgentOverride["skills"], loaded: () => string[]) => {
  const problem =
    Array.isArray(skills) && skills.length > 0 ? unknownSkillsProblem(skills, loaded()) : undefined;

  return problem ? `agents.${name}.skills ${problem}; dropped` : undefined;
};

const checkedOverride = (
  name: string,
  override: AgentOverride,
  check: OverrideCheck,
  loaded: () => string[],
) => {
  const badModel = modelNotice(name, override.model, check);
  const badSkills = skillsNotice(name, override.skills, loaded);
  const kept: AgentOverride = {
    ...override,
    model: badModel ? undefined : override.model,
    skills: badSkills ? undefined : override.skills,
  };
  const notices = [badModel, badSkills]
    .filter((message): message is string => message !== undefined)
    .map((message): OverrideNotice => ({ level: "warning", message }));

  return { kept, notices };
};

const once = <T>(read: () => T) => {
  let value: { read: T } | undefined;

  return () => {
    value ??= { read: read() };

    return value.read;
  };
};

const overridden = (definition: AgentDefinition, override: AgentOverride): AgentDefinition => {
  const model = override.model === INHERIT_MODEL ? undefined : (override.model ?? definition.model);

  return {
    ...definition,
    model,
    thinking: override.thinking ?? definition.thinking,
    skills: override.skills ?? definition.skills,
  };
};

const applyOverrides = (
  definitions: Map<string, AgentDefinition>,
  check: OverrideCheck,
  loaded: () => string[],
) => {
  const entries = Object.entries(check.overrides);

  if (entries.length === 0) {
    return [];
  }

  const untrustedDir = check.untrustedDir;
  const untrusted = once(() => (untrustedDir ? agentNamesIn(untrustedDir) : new Set<string>()));

  return entries.flatMap(([name, override]): OverrideNotice[] => {
    const definition = definitions.get(name);

    if (!definition && untrusted().has(name)) {
      return [
        {
          level: "info",
          message: `agents.${name}: "${name}" is defined only in this project's .pi/agents, which is not trusted; override not applied`,
        },
      ];
    }

    if (!definition) {
      return [{ level: "warning", message: `agents.${name}: no agent named "${name}"; override ignored` }];
    }

    const { kept, notices } = checkedOverride(name, override, check, loaded);

    definitions.set(name, overridden(definition, kept));

    return notices;
  });
};

const unknownFrontmatterSkills = (
  fromFiles: Map<string, AgentDefinition>,
  definitions: Map<string, AgentDefinition>,
  paths: Map<string, string>,
  loaded: () => string[],
) =>
  [...definitions.values()].flatMap((definition): DefinitionError[] => {
    const { name, skills } = definition;
    const problem =
      Array.isArray(skills) && skills.length > 0 && skills === fromFiles.get(name)?.skills
        ? unknownSkillsProblem(skills, loaded())
        : undefined;

    return problem
      ? [{ path: paths.get(name) ?? name, message: `skills ${problem}; those are not loaded` }]
      : [];
  });

export const loadDefinitions = (dirs: DefinitionDir[], check?: OverrideCheck): LoadResult => {
  const definitions = new Map<string, AgentDefinition>();
  const errors: DefinitionError[] = [];
  const warnings: DefinitionError[] = [];
  const paths = new Map<string, string>();

  dirs.forEach((dir) => {
    const seen = new Map<string, string>();

    markdownFiles(dir.path).forEach((path) => {
      const parsed = parseDefinition(readFileSync(path, "utf8"), path, dir.source);

      if (!parsed.definition) {
        errors.push({ path, message: parsed.errors.join("; ") });
        return;
      }

      const { name } = parsed.definition;
      const earlier = seen.get(name);

      if (earlier) {
        warnings.push({ path, message: `agent "${name}" is also defined in ${earlier}; this file wins` });
      }

      seen.set(name, path);
      paths.set(name, path);
      definitions.set(name, parsed.definition);

      parsed.warnings.forEach((message) => {
        warnings.push({ path, message });
      });
    });
  });

  pruneSubagentGraph(definitions, errors);

  if (!check) {
    return { definitions, errors, warnings, notices: [] };
  }

  const fromFiles = new Map(definitions);
  const loaded = once(check.skillNames);
  const notices = applyOverrides(definitions, check, loaded);

  warnings.push(...unknownFrontmatterSkills(fromFiles, definitions, paths, loaded));

  return { definitions, errors, warnings, notices };
};

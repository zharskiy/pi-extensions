import {
  type OverrideField,
  overrideModel,
  overrideSkills,
  overrideThinking,
  unknownSkillsProblem,
} from "../../model/agent-override.ts";
import { type AgentOverride, ALL, INHERIT_MODEL } from "../../model/agent-schema.ts";
import { SCOPES, type Scope, type SetupChange } from "./form.ts";

export const SETUP_USAGE = [
  "/agents setup [<agent> model=<provider/id[:thinking]|inherit> thinking=<level>",
  "skills=<a,b|all|none> scope=<project|user>]",
].join(" ");

export type LineCheck = {
  agents: string[];
  skills: string[];
  defaultScope: Scope;
  resolveModel(request: string): { ref: string } | { error: string };
};

type LineRequest = { change: SetupChange; scope: Scope };

type Parsed = OverrideField & { scope?: Scope };

const parseModel = (value: string, check: LineCheck): Parsed => {
  const field = overrideModel(value);
  const model = field.patch.model;

  if (field.error || model === undefined || model === INHERIT_MODEL) {
    return field;
  }

  const resolved = check.resolveModel(model);

  return "error" in resolved
    ? { patch: {}, error: resolved.error }
    : { patch: { ...field.patch, model: resolved.ref } };
};

const skillsValue = (value: string) => {
  if (value === ALL) {
    return ALL;
  }

  if (value === "none") {
    return [];
  }

  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
};

const parseSkills = (value: string, check: LineCheck): Parsed => {
  const field = overrideSkills(skillsValue(value));
  const skills = field.patch.skills;
  const problem = Array.isArray(skills) ? unknownSkillsProblem(skills, check.skills) : undefined;

  return problem ? { patch: {}, error: `skills ${problem}` } : field;
};

const PARSERS: Record<string, (value: string, check: LineCheck) => Parsed> = {
  model: parseModel,
  thinking: (value) => overrideThinking(value),
  skills: parseSkills,
  scope: (value) =>
    SCOPES.includes(value as Scope)
      ? { patch: {}, scope: value as Scope }
      : { patch: {}, error: `scope must be ${SCOPES.join(" or ")}` },
};

const parsePair = (pair: string, check: LineCheck): Parsed => {
  const equals = pair.indexOf("=");
  const key = equals < 0 ? pair : pair.slice(0, equals);
  const parser = PARSERS[key];

  if (!parser || equals < 0) {
    const keys = Object.keys(PARSERS).join(", ");

    return { patch: {}, error: `"${pair}" is not key=value with a key of ${keys}` };
  }

  return parser(pair.slice(equals + 1), check);
};

export const parseSetupLine = (args: string, check: LineCheck): LineRequest | { error: string } => {
  const [name, ...pairs] = args.trim().split(/\s+/).filter(Boolean);

  if (!name || pairs.length === 0) {
    return { error: `usage: ${SETUP_USAGE}` };
  }

  if (!check.agents.includes(name)) {
    return { error: `no agent named "${name}" (agents: ${check.agents.join(", ")})` };
  }

  const parsed = pairs.map((pair) => parsePair(pair, check));
  const errors = parsed.flatMap((entry) => (entry.error ? [entry.error] : []));

  if (errors.length > 0) {
    return { error: errors.join("; ") };
  }

  const patch: AgentOverride = Object.assign({}, ...parsed.map((entry) => entry.patch));
  const scope = parsed.reduce<Scope>((chosen, entry) => entry.scope ?? chosen, check.defaultScope);

  if (Object.keys(patch).length === 0) {
    return { error: `nothing to set; usage: ${SETUP_USAGE}` };
  }

  return { change: { name, patch }, scope };
};

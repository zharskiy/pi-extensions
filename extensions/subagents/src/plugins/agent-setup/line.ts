import { splitModelRequest, THINKING_LEVELS } from "../../../../../core/adapter/contract.ts";
import { type AgentOverride, ALL, INHERIT_MODEL } from "../../model/agent-schema.ts";
import { SCOPES, type Scope, type SetupChange } from "./form.ts";

export const SETUP_USAGE = [
  "/agents setup [<agent> model=<provider/id[:thinking]|inherit> thinking=<level>",
  "skills=<a,b|all|none> scope=<project|user>]",
].join(" ");

export type LineCheck = {
  agents: string[];
  skills: string[];
  resolveModel(request: string): { ref?: string; error?: string };
};

export type LineRequest = { change: SetupChange; scope: Scope };

type Parsed = { patch: AgentOverride; scope?: Scope; error?: string };

const parseModel = (value: string, check: LineCheck): Parsed => {
  if (value === INHERIT_MODEL) {
    return { patch: { model: INHERIT_MODEL } };
  }

  const request = splitModelRequest(value);

  if (request.error) {
    return { patch: {}, error: request.error };
  }

  const resolved = check.resolveModel(request.name);
  const thinking = request.thinking ? { thinking: request.thinking } : {};

  if (!resolved.ref) {
    return { patch: {}, error: resolved.error };
  }

  return { patch: { model: resolved.ref, ...thinking } };
};

const parseSkills = (value: string, check: LineCheck): Parsed => {
  if (value === ALL || value === "none") {
    return { patch: { skills: value === ALL ? ALL : [] } };
  }

  const names = Array.from(new Set(value.split(",").map((name) => name.trim()))).filter(Boolean);
  const unknown = names.filter((name) => !check.skills.includes(name));
  const loaded = check.skills.length > 0 ? check.skills.join(", ") : "none";

  return unknown.length > 0
    ? { patch: {}, error: `unknown skill(s) ${unknown.join(", ")}; loaded skills: ${loaded}` }
    : { patch: { skills: names } };
};

const PARSERS: Record<string, (value: string, check: LineCheck) => Parsed> = {
  model: parseModel,
  thinking: (value) =>
    THINKING_LEVELS.includes(value)
      ? { patch: { thinking: value } }
      : { patch: {}, error: `thinking must be one of ${THINKING_LEVELS.join(", ")}` },
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
  const scope = parsed.reduce<Scope>((chosen, entry) => entry.scope ?? chosen, "project");

  if (Object.keys(patch).length === 0) {
    return { error: `nothing to set; usage: ${SETUP_USAGE}` };
  }

  return { change: { name, patch }, scope };
};

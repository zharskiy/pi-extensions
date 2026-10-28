import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import {
  ensureProjectDir,
  errorText,
  homeRelative,
  projectSettingsPath,
  readText,
  userSettingsPath,
} from "../../../platform/shared/index.ts";
import type { Scope, Source } from "./args.ts";
import { type Plan, planImport, type Skipped } from "./plan.ts";
import { type Found, findServers } from "./sources.ts";

export const MCP_FILE = "mcp.json";

const NOT_SELECTED = "not selected";

export type Pair = {
  source: Source;
  scope: Scope;
  found: Found;
  plan: Plan;
  path: string;
  target: string;
  text?: string;
};

type Scan =
  | { kind: "pairs"; pairs: Pair[] }
  | { kind: "untrusted" }
  | { kind: "empty"; files: string[]; targets: string[]; skipped: Skipped[]; present: boolean };

type Prepared = { found: Found; pair?: Pair; problem?: string };

type Places = { home: string; cwd: string; agentDir: string };

const PAIRS: readonly { source: Source; scope: Scope }[] = [
  { source: "claude", scope: "user" },
  { source: "claude", scope: "project" },
  { source: "cursor", scope: "user" },
  { source: "cursor", scope: "project" },
];

const hasServers = (found: Found) => found.origins.some((origin) => Object.keys(origin.servers).length > 0);

export const prepareImport = (source: Source, scope: Scope, { home, cwd, agentDir }: Places): Prepared => {
  const found = findServers(source, scope, { home, cwd });

  if (!hasServers(found)) {
    return { found };
  }

  const project = scope === "project";
  const path = project ? projectSettingsPath(cwd, MCP_FILE) : userSettingsPath(agentDir, MCP_FILE);
  const target = project ? `.pi/${MCP_FILE}` : homeRelative(path, home);
  let text: string | undefined;

  try {
    text = readText(path);
  } catch (error) {
    return { found, problem: `cannot read ${path}: ${errorText(error)}` };
  }

  const plan = planImport(source, found.origins, { label: target, text }, { home, sep });

  if (plan.error) {
    return { found, problem: `${plan.error}; fix it first, nothing written` };
  }

  return { found, pair: { source, scope, found, plan, path, target, text } };
};

export const writeImport = (path: string, text: string | undefined, projectCwd?: string) => {
  if (text === undefined) {
    return undefined;
  }

  try {
    if (projectCwd !== undefined) {
      ensureProjectDir(projectCwd);
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    return undefined;
  } catch (error) {
    return `cannot write ${path}: ${errorText(error)}`;
  }
};

export const selectedPlan = (pair: Pair, names: readonly string[], home: string): Plan => {
  const chosen = new Set(names);
  const origins = pair.found.origins.map((origin) => ({
    ...origin,
    servers: Object.fromEntries(Object.entries(origin.servers).filter(([name]) => chosen.has(name))),
  }));
  const plan = planImport(pair.source, origins, { label: pair.target, text: pair.text }, { home, sep });
  const unchecked = pair.plan.added
    .filter((entry) => !chosen.has(entry.name))
    .map((entry) => ({ name: entry.name, origin: entry.origin, reason: NOT_SELECTED }));

  return { ...plan, skipped: [...pair.plan.skipped, ...unchecked] };
};

const foundNames = (pair: Pair) => [
  ...new Set(pair.found.origins.flatMap((origin) => Object.keys(origin.servers))),
];

const allPresent = (pair: Pair) => {
  const present = new Set(pair.plan.skipped.filter((skip) => skip.present).map((skip) => skip.name));

  return foundNames(pair).every((name) => present.has(name));
};

const visibleScope = (scope: Scope, trusted: boolean) => trusted || scope === "user";

const scanPairs = (candidates: readonly Pair[], trusted: boolean): Scan => {
  const addable = candidates.filter((pair) => pair.plan.added.length > 0);
  const pairs = addable.filter((pair) => visibleScope(pair.scope, trusted));

  if (pairs.length > 0) {
    return { kind: "pairs", pairs };
  }

  if (addable.length > 0) {
    return { kind: "untrusted" };
  }

  const withServers = candidates.filter(
    (pair) => visibleScope(pair.scope, trusted) && foundNames(pair).length > 0,
  );
  const files = withServers.flatMap((pair) =>
    pair.found.origins
      .filter((origin) => Object.keys(origin.servers).length > 0)
      .map((origin) => origin.label),
  );

  return {
    kind: "empty",
    files,
    targets: [...new Set(withServers.map((pair) => pair.target))],
    skipped: withServers.flatMap((pair) => pair.plan.skipped),
    present: withServers.length > 0 && withServers.every(allPresent),
  };
};

export const surveyImports = (places: Places, trusted: boolean) => {
  const prepared = PAIRS.map(({ source, scope }) => ({ scope, ...prepareImport(source, scope, places) }));
  const visible = prepared.filter((item) => visibleScope(item.scope, trusted));
  const candidates = prepared.flatMap((item) => (item.pair ? [item.pair] : []));

  return {
    warnings: [...new Set(visible.flatMap((item) => item.found.problems))],
    problems: [...new Set(visible.flatMap((item) => (item.problem ? [item.problem] : [])))],
    checked: [...new Set(visible.flatMap((item) => item.found.checked))],
    scan: scanPairs(candidates, trusted),
  };
};

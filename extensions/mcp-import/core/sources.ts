import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { errorText, isPlainObject } from "../../../platform/shared/index.ts";
import type { Scope, Source } from "./args.ts";

export type Origin = { label: string; servers: Record<string, unknown>; note?: string };

export type Found = { origins: Origin[]; checked: string[]; problems: string[] };

type Places = { home: string; cwd: string };

type Read = { data?: unknown; problem?: string };

const readJson = (path: string): Read => {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { problem: `cannot read ${path}: ${errorText(error)}` };
  }
};

const serversOf = (data: unknown): Record<string, unknown> | string => {
  if (!isPlainObject(data)) {
    return "expected a JSON object";
  }

  if (data.mcpServers === undefined) {
    return {};
  }

  return isPlainObject(data.mcpServers) ? data.mcpServers : 'expected "mcpServers" to be an object';
};

const claudeLocalServers = (data: unknown, dirs: readonly string[]): Record<string, unknown> | string => {
  if (!isPlainObject(data) || !isPlainObject(data.projects)) {
    return {};
  }

  const projects = data.projects;
  const key = dirs.find((dir) => isPlainObject(projects[dir]));

  return key === undefined ? {} : serversOf(projects[key]);
};

const projectDirs = (cwd: string) => {
  try {
    return [...new Set([cwd, realpathSync(cwd)])];
  } catch {
    return [cwd];
  }
};

type Spec = {
  label: string;
  path: string;
  servers: (data: unknown) => Record<string, unknown> | string;
  note?: string;
};

const LOCAL_NOTE =
  "comes from your private Claude local scope; .pi/mcp.json may be committed, so check it for credentials";

const specsFor = (source: Source, scope: Scope, { home, cwd }: Places): Spec[] => {
  const claudeJson = join(home, ".claude.json");

  if (source === "claude" && scope === "user") {
    return [{ label: "~/.claude.json (user scope)", path: claudeJson, servers: serversOf }];
  }

  if (source === "claude") {
    return [
      {
        label: "~/.claude.json (local scope of this project)",
        path: claudeJson,
        servers: (data) => claudeLocalServers(data, projectDirs(cwd)),
        note: LOCAL_NOTE,
      },
      { label: ".mcp.json", path: join(cwd, ".mcp.json"), servers: serversOf },
    ];
  }

  return scope === "user"
    ? [{ label: "~/.cursor/mcp.json", path: join(home, ".cursor", "mcp.json"), servers: serversOf }]
    : [{ label: ".cursor/mcp.json", path: join(cwd, ".cursor", "mcp.json"), servers: serversOf }];
};

export const findServers = (source: Source, scope: Scope, places: Places): Found => {
  const specs = specsFor(source, scope, places);
  const reads = specs.map((spec) => ({ spec, read: readJson(spec.path) }));

  const parsed = reads
    .filter(({ read }) => read.data !== undefined)
    .map(({ spec, read }) => ({ spec, servers: spec.servers(read.data) }));

  return {
    origins: parsed.flatMap(({ spec, servers }) =>
      typeof servers === "string"
        ? []
        : [{ label: spec.label, servers, ...(spec.note ? { note: spec.note } : {}) }],
    ),
    checked: specs.map((spec) => spec.label),
    problems: [
      ...reads.flatMap(({ read }) => (read.problem ? [read.problem] : [])),
      ...parsed.flatMap(({ spec, servers }) =>
        typeof servers === "string" ? [`${spec.path}: ${servers}`] : [],
      ),
    ],
  };
};

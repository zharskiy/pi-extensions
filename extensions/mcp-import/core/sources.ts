import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import {
  errorText,
  homeRelative,
  isPlainObject,
  type SettingsScope,
} from "../../../platform/shared/index.ts";
import type { Source } from "./args.ts";

export type Origin = { label: string; servers: Record<string, unknown>; note?: string };

export type Found = { origins: Origin[]; checked: string[]; problems: string[] };

type Places = { home: string; cwd: string; codexHome: string };

type Read = { data?: unknown; problem?: string };

const parseToml = (text: string) => {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new Error(`invalid TOML at line ${error.line}, column ${error.column}`);
    }

    throw error;
  }
};

const readConfig = (path: string, parseText: (text: string) => unknown): Read => {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return { data: parseText(readFileSync(path, "utf8")) };
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

const codexServers = (data: unknown): Record<string, unknown> | string => {
  if (!isPlainObject(data) || data.mcp_servers === undefined) {
    return {};
  }

  return isPlainObject(data.mcp_servers) ? data.mcp_servers : 'expected "mcp_servers" to be a table';
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
  parse?: (text: string) => unknown;
  servers: (data: unknown) => Record<string, unknown> | string;
  note?: string;
};

const LOCAL_NOTE =
  "comes from your private Claude local scope; .pi/mcp.json may be committed, so check it for credentials";

const specsFor = (source: Source, scope: SettingsScope, { home, cwd, codexHome }: Places): Spec[] => {
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

  if (source === "codex") {
    const user = scope === "user";
    const path = user ? join(codexHome, "config.toml") : join(cwd, ".codex", "config.toml");

    return [
      {
        label: user ? homeRelative(path, home) : ".codex/config.toml",
        path,
        parse: parseToml,
        servers: codexServers,
      },
    ];
  }

  return scope === "user"
    ? [{ label: "~/.cursor/mcp.json", path: join(home, ".cursor", "mcp.json"), servers: serversOf }]
    : [{ label: ".cursor/mcp.json", path: join(cwd, ".cursor", "mcp.json"), servers: serversOf }];
};

export const findServers = (source: Source, scope: SettingsScope, places: Places): Found => {
  const specs = specsFor(source, scope, places);
  const reads = specs.map((spec) => ({ spec, read: readConfig(spec.path, spec.parse ?? JSON.parse) }));

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

import { join } from "node:path";
import { type Endpoint, endpointOf, uniqueEndpoints } from "../endpoints.ts";
import { mergeSections, type Section } from "../rules.ts";
import type { GlabHost, ToolsInput } from "../types.ts";
import {
  COMMAND_TTL_SECONDS,
  emptySection,
  firstExisting,
  onPath,
  placeholderRules,
  toolPlaceholder,
} from "./files.ts";

interface ConfigHost {
  host: string;
  fields: Record<string, string>;
}

interface ParseState {
  inHosts: boolean;
  hostIndent?: number;
  hosts: ConfigHost[];
}

const GITLAB = "gitlab.com";

const TOP_KEY = /^([A-Za-z0-9_-]+):/;

const NESTED_KEY = /^(\s+)([A-Za-z0-9._-]+):\s*(.*?)\s*$/;

const HOST_NAME = /^[A-Za-z0-9.-]+$/;

const unquote = (value: string) =>
  /^"(.*)"$/.test(value) || /^'(.*)'$/.test(value) ? value.slice(1, -1) : value;

const configPaths = (input: ToolsInput) => {
  if (input.env.GLAB_CONFIG_DIR) {
    return [join(input.env.GLAB_CONFIG_DIR, "config.yml")];
  }

  const platformHome =
    input.platform === "darwin"
      ? join(input.home, "Library", "Application Support")
      : join(input.home, ".config");

  return [
    join(input.home, ".config", "glab-cli", "config.yml"),
    join(input.env.XDG_CONFIG_HOME || platformHome, "glab-cli", "config.yml"),
  ];
};

const parseLine = (state: ParseState, line: string): ParseState => {
  if (line.trim() === "" || line.trim().startsWith("#")) {
    return state;
  }

  const top = TOP_KEY.exec(line);

  if (top !== null) {
    return { inHosts: top[1] === "hosts", hosts: state.hosts };
  }

  const nested = NESTED_KEY.exec(line);

  if (!state.inHosts || nested === null) {
    return state;
  }

  const [, indent = "", key = "", value = ""] = nested;
  const hostIndent = state.hostIndent ?? indent.length;

  if (indent.length === hostIndent) {
    return { ...state, hostIndent, hosts: [...state.hosts, { host: key.toLowerCase(), fields: {} }] };
  }

  const current = state.hosts.at(-1);

  if (current !== undefined && indent.length > hostIndent) {
    current.fields[key] = unquote(value);
  }

  return state;
};

const hostsOf = (text: string) =>
  text
    .split(/\r?\n/)
    .reduce<ParseState>(parseLine, { inHosts: false, hosts: [] })
    .hosts.filter((entry) => HOST_NAME.test(entry.host));

const apiEndpoint = (entry: ConfigHost): Endpoint[] => {
  const apiHost = entry.fields.api_host;

  if (apiHost === undefined || apiHost === "" || apiHost.toLowerCase() === entry.host) {
    return [];
  }

  const result = endpointOf(`https://${apiHost}`);

  return "endpoint" in result ? [result.endpoint] : [];
};

const tokenCommand = (glab: string, host: string) => [glab, "config", "get", "token", "--host", host];

const tokenOnHost = async (input: ToolsInput, glab: string, host: string) => {
  const [file = glab, ...args] = tokenCommand(glab, host);
  const result = await input.runner.run(file, args).catch(() => undefined);

  return result !== undefined && result.code === 0 && result.stdout.trim() !== "";
};

const rendered = (entry: ConfigHost, token: string): GlabHost => {
  const { user, api_host: apiHost, api_protocol: apiProtocol, is_oauth2: oauth } = entry.fields;
  const name = oauth === "true" ? "oauth2" : user;

  return {
    host: entry.host,
    token,
    ...(name === undefined || name === "" ? {} : { user: name }),
    ...(apiHost === undefined || apiHost === "" ? {} : { apiHost }),
    ...(apiProtocol === undefined || apiProtocol === "" ? {} : { apiProtocol }),
  };
};

const hostSection = async (
  input: ToolsInput,
  glab: string,
  entry: ConfigHost,
  ghHosts: Set<string>,
): Promise<Section<GlabHost[]>> => {
  if (ghHosts.has(entry.host)) {
    return {
      value: [],
      rules: [],
      notices: [`glab ${entry.host}: gh on the host also signs in to it; the sandbox uses the gh credential`],
    };
  }

  if (!(await tokenOnHost(input, glab, entry.host))) {
    return {
      value: [],
      rules: [],
      notices: [
        `glab ${entry.host}: no token on the host; run glab auth login --hostname ${entry.host} there`,
      ],
    };
  }

  const identity = `glab:${entry.host}:token`;
  const token = toolPlaceholder(input, identity);
  const endpoints = uniqueEndpoints([{ host: entry.host }, ...apiEndpoint(entry)]);

  return {
    value: [rendered(entry, token)],
    rules: placeholderRules(identity, endpoints, token, {
      command: tokenCommand(glab, entry.host),
      ttlSeconds: COMMAND_TTL_SECONDS,
    }),
    notices: [],
  };
};

export const deriveGlab = async (input: ToolsInput, ghHosts: Set<string>): Promise<Section<GlabHost[]>> => {
  const config = await firstExisting(configPaths(input));
  const hosts = hostsOf(config?.text ?? "");
  const glab = hosts.length === 0 ? undefined : await onPath(input, "glab");

  if (glab === undefined) {
    return emptySection([]);
  }

  const merged = mergeSections(
    await Promise.all(hosts.map((entry) => hostSection(input, glab, entry, ghHosts))),
  );

  return { value: merged.values.flat(), rules: merged.rules, notices: merged.notices };
};

export const glabEnv = (hosts: GlabHost[]): Record<string, string> => {
  const [only] = hosts;

  return hosts.length === 1 && only?.host === GITLAB ? { GITLAB_TOKEN: only.token, GITLAB_HOST: GITLAB } : {};
};

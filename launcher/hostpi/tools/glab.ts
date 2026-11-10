import { join } from "node:path";
import { type Endpoint, endpointOf, uniqueEndpoints } from "../endpoints.ts";
import { findOnPath } from "../path-search.ts";
import { mergeSections, noticeOnly, placeholderOf, rulesFor, type Section } from "../rules.ts";
import type { GlabHost, ToolsInput } from "../types.ts";
import {
  firstExisting,
  noCredentialsNotice,
  sandboxedConfigNotice,
  TOKEN_PROBE_TIMEOUT_MS,
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

const LABEL = "glab";

interface ConfigPath {
  path: string;
  variable?: string;
}

const configPaths = (input: ToolsInput): ConfigPath[] => {
  if (input.env.GLAB_CONFIG_DIR) {
    return [{ path: join(input.env.GLAB_CONFIG_DIR, "config.yml"), variable: "GLAB_CONFIG_DIR" }];
  }

  const platformHome =
    input.platform === "darwin"
      ? join(input.home, "Library", "Application Support")
      : join(input.home, ".config");

  return [
    { path: join(input.home, ".config", "glab-cli", "config.yml") },
    {
      path: join(input.env.XDG_CONFIG_HOME || platformHome, "glab-cli", "config.yml"),
      ...(input.env.XDG_CONFIG_HOME ? { variable: "XDG_CONFIG_HOME" } : {}),
    },
  ];
};

const checkedPath = async (input: ToolsInput, candidate: ConfigPath) => {
  const notice =
    candidate.variable === undefined
      ? undefined
      : await sandboxedConfigNotice(input, LABEL, candidate.variable, candidate.path);

  return notice === undefined ? noticeOnly([candidate.path]) : noticeOnly([], notice);
};

const readConfig = async (input: ToolsInput) => {
  const checked = mergeSections(
    await Promise.all(configPaths(input).map((path) => checkedPath(input, path))),
  );

  return { config: await firstExisting(checked.values.flat()), notices: checked.notices };
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

type TokenState = "present" | "missing" | "timedOut";

const tokenOnHost = async (input: ToolsInput, glab: string, entry: ConfigHost): Promise<TokenState> => {
  if ((entry.fields.token ?? "") !== "") {
    return "present";
  }

  const [file = glab, ...args] = tokenCommand(glab, entry.host);
  const result = await input.runner
    .run(file, args, { timeoutMs: TOKEN_PROBE_TIMEOUT_MS })
    .catch(() => undefined);

  if (result?.timedOut === true) {
    return "timedOut";
  }

  return result !== undefined && result.code === 0 && result.stdout.trim() !== "" ? "present" : "missing";
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
): Promise<Section<GlabHost[]>> => {
  const state = await tokenOnHost(input, glab, entry);

  if (state === "timedOut") {
    return noticeOnly(
      [],
      noCredentialsNotice(`${LABEL} ${entry.host}`, `${glab} config get token`, TOKEN_PROBE_TIMEOUT_MS),
    );
  }

  if (state === "missing") {
    return noticeOnly(
      [],
      `glab ${entry.host}: no token on the host; run glab auth login --hostname ${entry.host} there`,
    );
  }

  const identity = `glab:${entry.host}:token`;
  const token = placeholderOf(input, identity);
  const endpoints = uniqueEndpoints([{ host: entry.host }, ...apiEndpoint(entry)]);

  return {
    value: [rendered(entry, token)],
    rules: rulesFor(identity, endpoints, {
      placeholder: token,
      secret: { command: tokenCommand(glab, entry.host) },
    }),
    notices: [],
  };
};

export const deriveGlab = async (input: ToolsInput): Promise<Section<GlabHost[]>> => {
  const { config, notices } = await readConfig(input);
  const entries = hostsOf(config?.text ?? "");
  const glab = entries.length === 0 ? undefined : await findOnPath(input.env, "glab", input.excludedRoots);

  if (glab === undefined) {
    return noticeOnly([], ...notices);
  }

  const merged = mergeSections(await Promise.all(entries.map((entry) => hostSection(input, glab, entry))));

  return { value: merged.values.flat(), rules: merged.rules, notices: [...notices, ...merged.notices] };
};

export const glabEnv = (hosts: GlabHost[]): Record<string, string> => {
  const [only] = hosts;

  return hosts.length === 1 && only?.host === GITLAB ? { GITLAB_TOKEN: only.token, GITLAB_HOST: GITLAB } : {};
};

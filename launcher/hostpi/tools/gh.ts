import { join } from "node:path";
import type { Endpoint } from "../endpoints.ts";
import { findOnPath } from "../path-search.ts";
import { mergeSections, noticeOnly, placeholderOf, rulesFor, type Section } from "../rules.ts";
import type { ToolHost, ToolsInput } from "../types.ts";
import { readOptional, sandboxedConfigNotice, xdgConfigHome } from "./files.ts";

const HOST_LINE = /^([A-Za-z0-9.-]+):\s*$/;

const GITHUB = "github.com";

const ENTERPRISE_CLOUD = ".ghe.com";

const LABEL = "gh";

const hostsFile = (input: ToolsInput) => {
  const variable = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME"].find((name) => input.env[name]) ?? "";
  const path = join(input.env.GH_CONFIG_DIR || join(xdgConfigHome(input), "gh"), "hosts.yml");

  return { path, variable };
};

const readHosts = async (input: ToolsInput): Promise<Section<string | undefined>> => {
  const { path, variable } = hostsFile(input);
  const notice = variable === "" ? undefined : await sandboxedConfigNotice(input, LABEL, variable, path);

  return notice === undefined ? noticeOnly(await readOptional(path)) : noticeOnly(undefined, notice);
};

const hostsOf = (text: string) =>
  text.split(/\r?\n/).flatMap((line) => {
    const host = HOST_LINE.exec(line)?.[1];

    return host === undefined ? [] : [host.toLowerCase()];
  });

const endpointsOf = (host: string): Endpoint[] => {
  if (host === GITHUB) {
    return [{ host }, { host: `api.${GITHUB}` }, { host: `uploads.${GITHUB}` }];
  }

  return host.endsWith(ENTERPRISE_CLOUD) ? [{ host }, { host: `api.${host}` }] : [{ host }];
};

const hostSection = (input: ToolsInput, gh: string, host: string): Section<ToolHost> => {
  const identity = `gh:${host}:token`;
  const token = placeholderOf(input, identity);

  return {
    value: { host, token },
    rules: rulesFor(identity, endpointsOf(host), {
      placeholder: token,
      secret: { command: [gh, "auth", "token", "--hostname", host] },
    }),
    notices: [],
  };
};

export const deriveGh = async (input: ToolsInput): Promise<Section<ToolHost[]>> => {
  const file = await readHosts(input);
  const hosts = [...new Set(hostsOf(file.value ?? ""))];
  const gh = hosts.length === 0 ? undefined : await findOnPath(input.env, "gh", input.excludedRoots);

  if (gh === undefined) {
    return noticeOnly([], ...file.notices);
  }

  const merged = mergeSections(hosts.map((host) => hostSection(input, gh, host)));

  return { value: merged.values, rules: merged.rules, notices: merged.notices };
};

export const ghEnv = (hosts: ToolHost[]): Record<string, string> => {
  const github = hosts.find((entry) => entry.host === GITHUB);

  return github === undefined ? {} : { GH_TOKEN: github.token };
};

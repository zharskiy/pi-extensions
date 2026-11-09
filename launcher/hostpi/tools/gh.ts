import { join } from "node:path";
import type { Endpoint } from "../endpoints.ts";
import { mergeSections, type Section } from "../rules.ts";
import type { ToolHost, ToolsInput } from "../types.ts";
import {
  COMMAND_TTL_SECONDS,
  emptySection,
  onPath,
  placeholderRules,
  readOptional,
  toolPlaceholder,
  xdgConfigHome,
} from "./files.ts";

const HOST_LINE = /^([A-Za-z0-9.-]+):\s*$/;

const VERSION = /gh version (\d+)\.(\d+)/;

const MINIMUM = { major: 2, minor: 17 };

const GITHUB = "github.com";

const ENTERPRISE_CLOUD = ".ghe.com";

const hostsFile = (input: ToolsInput) =>
  join(input.env.GH_CONFIG_DIR || join(xdgConfigHome(input), "gh"), "hosts.yml");

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

const versionOf = async (input: ToolsInput, gh: string) => {
  const result = await input.runner.run(gh, ["--version"]).catch(() => undefined);
  const match = VERSION.exec(result?.stdout ?? "");

  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
};

const tooOld = (version: { major: number; minor: number }) =>
  version.major < MINIMUM.major || (version.major === MINIMUM.major && version.minor < MINIMUM.minor);

const hostSection = (input: ToolsInput, gh: string, host: string): Section<ToolHost> => {
  const identity = `gh:${host}:token`;
  const token = toolPlaceholder(input, identity);

  return {
    value: { host, token },
    rules: placeholderRules(identity, endpointsOf(host), token, {
      command: [gh, "auth", "token", "--hostname", host],
      ttlSeconds: COMMAND_TTL_SECONDS,
    }),
    notices: [],
  };
};

export const deriveGh = async (input: ToolsInput): Promise<Section<ToolHost[]>> => {
  const text = await readOptional(hostsFile(input));
  const hosts = [...new Set(hostsOf(text ?? ""))];
  const gh = hosts.length === 0 ? undefined : await onPath(input, "gh");

  if (gh === undefined) {
    return emptySection([]);
  }

  const version = await versionOf(input, gh);

  if (version === undefined || tooOld(version)) {
    return {
      value: [],
      rules: [],
      notices: [
        "gh on the host is older than 2.17 or did not report its version; update it to use gh and git push in the sandbox",
      ],
    };
  }

  const merged = mergeSections(hosts.map((host) => hostSection(input, gh, host)));

  return { value: merged.values, rules: merged.rules, notices: merged.notices };
};

export const ghEnv = (hosts: ToolHost[]): Record<string, string> => {
  const github = hosts.find((entry) => entry.host === GITHUB);

  return github === undefined ? {} : { GH_TOKEN: github.token };
};

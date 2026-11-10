import { join } from "node:path";
import type { Endpoint } from "../endpoints.ts";
import { findOnPath } from "../path-search.ts";
import { mergeSections, noticeOnly, placeholderOf, rulesFor, type Section } from "../rules.ts";
import type { ToolHost, ToolsInput } from "../types.ts";
import {
  COMMAND_TTL_SECONDS,
  noCredentialsNotice,
  PROBE_TIMEOUT_MS,
  readOptional,
  sandboxedConfigNotice,
  xdgConfigHome,
} from "./files.ts";

const HOST_LINE = /^([A-Za-z0-9.-]+):\s*$/;

const VERSION = /gh version (\d+)\.(\d+)/;

const MINIMUM = { major: 2, minor: 17 };

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

type VersionCheck = { version?: { major: number; minor: number }; timedOut?: true };

const versionOf = async (input: ToolsInput, gh: string): Promise<VersionCheck> => {
  const result = await input.runner
    .run(gh, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS })
    .catch(() => undefined);

  if (result?.timedOut === true) {
    return { timedOut: true };
  }

  const match = VERSION.exec(result?.stdout ?? "");

  return match === null ? {} : { version: { major: Number(match[1]), minor: Number(match[2]) } };
};

const tooOld = (version: { major: number; minor: number }) =>
  version.major < MINIMUM.major || (version.major === MINIMUM.major && version.minor < MINIMUM.minor);

const hostSection = (input: ToolsInput, gh: string, host: string): Section<ToolHost> => {
  const identity = `gh:${host}:token`;
  const token = placeholderOf(input, identity);

  return {
    value: { host, token },
    rules: rulesFor(identity, endpointsOf(host), {
      placeholder: token,
      secret: { command: [gh, "auth", "token", "--hostname", host], ttlSeconds: COMMAND_TTL_SECONDS },
    }),
    notices: [],
  };
};

const OUTDATED =
  "gh on the host is older than 2.17 or did not report its version; update it to use gh and git push in the sandbox";

export const deriveGh = async (input: ToolsInput): Promise<Section<ToolHost[]>> => {
  const file = await readHosts(input);
  const hosts = [...new Set(hostsOf(file.value ?? ""))];
  const gh = hosts.length === 0 ? undefined : await findOnPath(input.env, "gh", input.excludedRoots);

  if (gh === undefined) {
    return noticeOnly([], ...file.notices);
  }

  const { version, timedOut } = await versionOf(input, gh);

  if (timedOut === true) {
    return noticeOnly([], noCredentialsNotice(LABEL, `${gh} --version`, PROBE_TIMEOUT_MS));
  }

  if (version === undefined || tooOld(version)) {
    return noticeOnly([], OUTDATED);
  }

  const merged = mergeSections(hosts.map((host) => hostSection(input, gh, host)));

  return { value: merged.values, rules: merged.rules, notices: merged.notices };
};

export const ghEnv = (hosts: ToolHost[]): Record<string, string> => {
  const github = hosts.find((entry) => entry.host === GITHUB);

  return github === undefined ? {} : { GH_TOKEN: github.token };
};

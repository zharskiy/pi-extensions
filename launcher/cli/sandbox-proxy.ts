import { authorityOf, egressAllowList, parentProxyOf, parseHostEntry } from "../config/index.ts";
import type { Launch } from "../grants/index.ts";
import {
  type DenialRecord,
  envSecretsFor,
  PROXY_LOG_LIMIT,
  type ProxyInput,
  type ProxyRecord,
  parentProxyAuth,
  parentProxyEnv,
  proxyToken,
} from "../proxy/index.ts";
import { errorMessage, LauncherError } from "../shared/index.ts";
import { busyLaunches } from "./busy.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, pathsOf, writeLines, writeNotices } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import { withGroundLock } from "./ground.ts";

export interface SandboxProxy {
  proxy: ProxyRecord;
  token: string;
}

type InputParts = Omit<ProxyInput, "token">;

const proxyInput = (deps: CliDeps, context: LaunchContext, host: HostSide): InputParts => {
  const { egress, tls } = context.effective.config;
  const parentAuth = parentProxyAuth(deps.env);

  return {
    allow: egressAllowList(egress),
    deny: egress.deny,
    privateHosts: egress.privateHosts,
    rules: host.derived.rules,
    derivedHosts: host.derived.hosts,
    envSecrets: envSecretsFor(host.derived.rules, deps.env),
    parentEnv: parentProxyEnv(deps.env),
    ...(parentAuth === undefined ? {} : { parentAuth }),
    extraCa: tls.extraCa.length > 0,
    piCommand: host.pi?.command ?? [],
    hostAgentDir: host.hostAgentDir,
    accessLogLimit: PROXY_LOG_LIMIT,
  };
};

const parentNotices = (deps: CliDeps) => {
  const target = parentProxyOf(deps.env);

  return target !== undefined && "unsupported" in target
    ? [`parent proxy: ${target.unsupported}; the proxy connects directly`]
    : [];
};

interface ProxyLaunch {
  launch: Launch;
  progress: (line: string) => void;
  signal: AbortSignal;
}

const startProxy = async (deps: CliDeps, context: LaunchContext, parts: InputParts, own: ProxyLaunch) => {
  const token = await proxyToken(context.stateDir);
  const started = await deps.proxy.ensure({
    stateDir: context.stateDir,
    input: { ...parts, token },
    env: deps.env,
    othersLive: async () => (await busyLaunches(context.stateDir, own.launch.launchId)) > 0,
  });

  writeNotices(deps, [...started.notices, ...parentNotices(deps)]);

  return { proxy: started.proxy, token };
};

export const openSandboxProxy = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  own: ProxyLaunch,
): Promise<SandboxProxy> => {
  const parts = proxyInput(deps, context, host);

  try {
    const lock = { stateDir: context.stateDir, progress: own.progress, signal: own.signal };

    return await withGroundLock(lock, () => startProxy(deps, context, parts, own));
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

export const deniedTargets = (denials: DenialRecord[]) => [
  ...new Map(denials.map((denial) => [authorityOf(denial.host, denial.port), denial])).values(),
];

const RESTRICTED_RULES = new Set(["private-address", "loopback", "link-local", "reserved-address"]);

const NEVER_REACHABLE =
  "IP addresses and loopback names are never reachable from the sandbox; use a host name";

const LOGIN_HINT = "log in again with pi --no-sandbox and /login";

const privateHostsHint = (deps: CliDeps, host: string) =>
  "problem" in parseHostEntry(host, { wildcard: false, port: false })
    ? NEVER_REACHABLE
    : `add ${host} to egress.privateHosts in ${pathsOf(deps).userConfigFile}`;

export interface DenialAdvice {
  reason?: string;
  fix?: string;
}

export const denialAdvice = (deps: CliDeps, denial: DenialRecord, target: string): DenialAdvice => {
  if (denial.rule === "egress.allow") {
    return { fix: `run pi sandbox egress allow ${target} on the host` };
  }

  if (RESTRICTED_RULES.has(denial.rule)) {
    return { reason: denial.reason, fix: privateHostsHint(deps, denial.host) };
  }

  const advice: Record<string, DenialAdvice> = {
    "egress.deny": { reason: "denied by egress.deny" },
    "plain-http": { reason: "plain HTTP is not proxied", fix: "use https" },
    upstream: { reason: `it could not be reached: ${denial.reason}` },
    credential: { reason: `it could not authenticate: ${denial.reason}` },
    login: { reason: denial.reason, fix: LOGIN_HINT },
  };

  return advice[denial.rule] ?? { reason: denial.reason };
};

const denialHint = (deps: CliDeps, denial: DenialRecord, target: string) => {
  const { reason, fix } = denialAdvice(deps, denial, target);

  return [reason, fix].filter((part) => part !== undefined).join("; ");
};

const blockedText = (deps: CliDeps, denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);

  return `${target} was blocked in the sandbox; ${denialHint(deps, denial, target)}`;
};

export const sandboxDenials = (deps: CliDeps, context: LaunchContext, since: number) =>
  deps.proxy.denials(context.stateDir, since).catch((): DenialRecord[] => []);

export const reportDenials = (deps: CliDeps) => (denials: DenialRecord[]) => {
  writeLines(
    deps.stderr,
    deniedTargets(denials).map((denial) => `pi-sandbox: ${blockedText(deps, denial)}`),
  );
};

import { authorityOf, egressAllowList } from "../config/index.ts";
import { type Launch, withRepoLaunchLock } from "../grants/index.ts";
import {
  type DenialRecord,
  envSecretsFor,
  PROXY_LOG_LIMIT,
  parentProxyAuth,
  parentProxyEnv,
  parentTarget,
  type RepoProxy,
  type RepoProxyInput,
  repoProxyToken,
} from "../proxy/index.ts";
import { errorMessage, LauncherError } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, writeLines, writeNotices } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import { othersLive } from "./launches.ts";

export interface SandboxProxy {
  proxy: RepoProxy;
  token: string;
}

type InputParts = Omit<RepoProxyInput, "token">;

const proxyInput = (deps: CliDeps, context: LaunchContext, host: HostSide): InputParts => {
  const { egress, tls } = context.effective.config;
  const parentAuth = parentProxyAuth(egress.parentProxy, deps.env);

  return {
    repoHash: context.repoHash,
    allow: egressAllowList(egress),
    deny: egress.deny,
    privateHosts: egress.privateHosts,
    grants: egress.grants,
    rules: host.derived.rules,
    derivedHosts: host.derived.hosts,
    envSecrets: envSecretsFor(host.derived.rules, deps.env),
    parent: egress.parentProxy,
    parentEnv: parentProxyEnv(deps.env),
    ...(parentAuth === undefined ? {} : { parentAuth }),
    extraCa: tls.extraCa.length > 0,
    piCommand: host.pi?.command ?? [],
    hostAgentDir: host.hostAgentDir,
    accessLogLimit: PROXY_LOG_LIMIT,
  };
};

const parentNotices = (deps: CliDeps, context: LaunchContext) => {
  const target = parentTarget(context.effective.config.egress.parentProxy, deps.env);

  return target !== undefined && "unsupported" in target
    ? [`egress.parentProxy: ${target.unsupported}; the proxy connects directly`]
    : [];
};

const startProxy = async (deps: CliDeps, context: LaunchContext, parts: InputParts, launch: Launch) => {
  const token = await repoProxyToken(context.stateDir, context.repoHash);
  const started = await deps.proxy.ensure({
    stateDir: context.stateDir,
    input: { ...parts, token },
    env: deps.env,
    othersLive: () => othersLive(context.stateDir, context.repoHash, launch.launchId),
  });

  writeNotices(deps, [...started.notices, ...parentNotices(deps, context)]);

  return { proxy: started.proxy, token };
};

export const openSandboxProxy = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  launch: Launch,
): Promise<SandboxProxy | undefined> => {
  if (!host.proxyNeeded) {
    return undefined;
  }

  const parts = proxyInput(deps, context, host);

  try {
    return await withRepoLaunchLock(context.stateDir, context.repoHash, () =>
      startProxy(deps, context, parts, launch),
    );
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

const deniedTargets = (denials: DenialRecord[]) => [
  ...new Map(denials.map((denial) => [authorityOf(denial.host, denial.port), denial])).values(),
];

const NOT_ALLOWED = ["egress.allow", "egress.port"];

const denialHint = (denial: DenialRecord, target: string, grants: boolean) => {
  if (NOT_ALLOWED.includes(denial.rule)) {
    return grants
      ? `run pi sandbox egress allow ${target} on the host`
      : `ask your administrator to add ${target} to egress.allow`;
  }

  const hints: Record<string, string> = {
    "private-address": `it resolves to a private address; add ${denial.host} to egress.privateHosts`,
    "egress.deny": "denied by policy",
    "plain-http": "plain HTTP is not proxied; use https",
    upstream: `it could not be reached: ${denial.reason}`,
  };

  return hints[denial.rule] ?? denial.reason;
};

const denialLine = (grants: boolean) => (denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);

  return `pi-sandbox: ${target} was blocked; ${denialHint(denial, target, grants)}`;
};

export const reportDenials = async (
  deps: CliDeps,
  context: LaunchContext,
  proxy: SandboxProxy | undefined,
  since: number,
) => {
  if (proxy === undefined) {
    return;
  }

  const denials = await deps.proxy.denials(context.stateDir, context.repoHash, since).catch(() => []);

  writeLines(deps.stderr, deniedTargets(denials).map(denialLine(context.effective.config.egress.grants)));
};

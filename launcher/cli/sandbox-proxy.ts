import {
  authorityOf,
  type CredentialRule,
  egressAllowList,
  isEgressLocked,
  parentProxyOf,
  TLS_PORT,
} from "../config/index.ts";
import { type Launch, othersLive, withRepoLaunchLock } from "../grants/index.ts";
import {
  type DenialRecord,
  envSecretsFor,
  PROXY_LOG_LIMIT,
  parentProxyAuth,
  parentProxyEnv,
  type RepoProxy,
  type RepoProxyInput,
  repoProxyToken,
} from "../proxy/index.ts";
import { errorMessage, LauncherError } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, pathsOf, writeLines, writeNotices } from "./deps.ts";
import type { HostSide } from "./derive.ts";

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
    derivedPrivateHosts: isEgressLocked(context.effective) ? [] : host.derived.privateHosts,
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
  const target = parentProxyOf(context.effective.config.egress.parentProxy, deps.env);

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
): Promise<SandboxProxy> => {
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

const PRIVATE_KINDS: Record<string, string> = {
  "private-address": "private",
  loopback: "loopback",
  "link-local": "link-local",
  "reserved-address": "reserved",
};

const loginHint = (context: LaunchContext) =>
  context.effective.config.fallback === "host"
    ? "log in again with pi --no-sandbox and /login"
    : "log in again with host pi";

const privateHostsHint = (deps: CliDeps, host: string, context: LaunchContext) =>
  isEgressLocked(context.effective)
    ? `egress is locked by the policy; ask your administrator to add ${host} to egress.privateHosts`
    : `add ${host} to egress.privateHosts in ${pathsOf(deps).userConfigFile}`;

export const denialHint = (deps: CliDeps, denial: DenialRecord, target: string, context: LaunchContext) => {
  if (denial.rule === "egress.allow") {
    return context.effective.config.egress.grants
      ? `run pi sandbox egress allow ${target} on the host from ${context.workspace.repoRoot}`
      : `ask your administrator to add ${target} to egress.allow`;
  }

  if (denial.rule === "private-address") {
    return `${denial.reason}; ${privateHostsHint(deps, denial.host, context)}`;
  }

  const kind = PRIVATE_KINDS[denial.rule];

  if (kind !== undefined) {
    return `it resolves to a ${kind} address; ${privateHostsHint(deps, denial.host, context)}`;
  }

  const hints: Record<string, string> = {
    "egress.deny": "denied by policy",
    "plain-http": "plain HTTP is not proxied; use https",
    upstream: `it could not be reached: ${denial.reason}`,
    credential: `it could not authenticate: ${denial.reason}`,
    login: `${denial.reason}; ${loginHint(context)}`,
  };

  return hints[denial.rule] ?? denial.reason;
};

const denialLine = (deps: CliDeps, context: LaunchContext) => (denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);

  return `pi-sandbox: ${target} was blocked in this folder's sandbox; ${denialHint(deps, denial, target, context)}`;
};

export const ruleAuthority = (rule: CredentialRule) =>
  authorityOf(rule.host.toLowerCase(), rule.port ?? TLS_PORT);

const explainedBy = (rules: CredentialRule[]) => {
  const authorities = new Set(rules.map(ruleAuthority));

  return (denial: DenialRecord) =>
    denial.credentialRule !== undefined || authorities.has(authorityOf(denial.host, denial.port));
};

export const reportDenials = async (
  deps: CliDeps,
  context: LaunchContext,
  proxy: SandboxProxy | undefined,
  since: number,
  explainedRules?: CredentialRule[],
) => {
  if (proxy === undefined) {
    return;
  }

  const denials = await deps.proxy.denials(context.stateDir, context.repoHash, since).catch(() => []);
  const explained = explainedRules === undefined ? () => false : explainedBy(explainedRules);

  writeLines(
    deps.stderr,
    deniedTargets(denials.filter((denial) => !explained(denial))).map(denialLine(deps, context)),
  );
};

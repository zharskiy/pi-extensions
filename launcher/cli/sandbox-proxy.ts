import type { Backend } from "../backend/index.ts";
import { authorityOf } from "../config/index.ts";
import { mcpDiscoverCommand } from "../hostpi/index.ts";
import {
  type DenialRecord,
  daemonEnv,
  envSecretsFor,
  type ProxyDynamic,
  type ProxyInstance,
  repoProxyToken,
  writeProxyDynamic,
} from "../proxy/index.ts";
import { errorMessage, LauncherError, sha256Hex } from "../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import { bundledPiCommand } from "./host-pi.ts";
import type { LaunchContext } from "./launch.ts";

export interface SandboxProxy {
  instance: ProxyInstance;
  policyHash: string;
  repoToken: string;
}

const CAP_RULE = "egress.cap";

const discoverCommandOf = async (deps: CliDeps) => {
  const pi = await deps.bundledPi();

  return pi === undefined ? {} : { discoverCommand: mcpDiscoverCommand(pi) };
};

const startProxy = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  try {
    const [listenHosts, piCommand, discover] = await Promise.all([
      backend.proxyListenHosts(),
      bundledPiCommand(deps),
      discoverCommandOf(deps),
    ]);

    return await deps.proxy.ensure({
      listenHosts,
      config: context.effective.config,
      stateDir: context.stateDir,
      env: daemonEnv(deps.env),
      home: deps.home,
      egressCap: context.effective.egressCap,
      piCommand: piCommand ?? [],
      ...discover,
    });
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

const dynamicOf = (host: HostSide, tokenHash: string): ProxyDynamic => ({
  version: 1,
  rules: host.derived.rules,
  derivedHosts: host.derived.hosts,
  vault: host.derived.vault,
  tokenHash,
});

const handEnvSecrets = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  proxy: { instance: ProxyInstance; tokenHash: string },
) => {
  const reply = await deps.proxy.control(proxy.instance, {
    type: "env-secrets",
    repoTokenHash: proxy.tokenHash,
    secrets: envSecretsFor(host.derived.rules, context.effective.config.egress.parentProxy, deps.env),
  });

  if (!reply.ok) {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: the proxy did not take the environment secrets: ${reply.error}`,
    );
  }
};

export const openSandboxProxy = async (
  deps: CliDeps,
  context: LaunchContext,
  host: HostSide,
  backend: Backend,
): Promise<SandboxProxy | undefined> => {
  if (!host.proxyNeeded) {
    return undefined;
  }

  const instance = await startProxy(deps, context, backend);
  const repoToken = await repoProxyToken(context.stateDir, instance.policyHash, context.repoHash);
  const tokenHash = sha256Hex(repoToken);

  await writeProxyDynamic(context.stateDir, instance.policyHash, dynamicOf(host, tokenHash));

  await handEnvSecrets(deps, context, host, { instance, tokenHash });

  return { instance, policyHash: instance.policyHash, repoToken };
};

const deniedTargets = (denials: DenialRecord[]) => [
  ...new Map(denials.map((denial) => [authorityOf(denial.host, denial.port), denial])).values(),
];

const denialLine = (denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);

  return denial.rule === CAP_RULE
    ? `pi-sandbox: ${target} is outside the allowlist set by policy or org`
    : `pi-sandbox: ${target} was blocked; run pi sandbox egress allow ${target}`;
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

  const denials = await deps.proxy
    .denials(context.stateDir, proxy.policyHash, { repoHash: context.repoHash, since })
    .catch(() => []);

  writeLines(deps.stderr, deniedTargets(denials).map(denialLine));
};

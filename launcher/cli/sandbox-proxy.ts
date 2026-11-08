import { authorityOf } from "../config/index.ts";
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
import type { LaunchContext } from "./launch.ts";

export interface SandboxProxy {
  instance: ProxyInstance;
  policyHash: string;
  repoToken: string;
}

const hostPiOf = (host: HostSide) => (host.pi === undefined ? {} : { piVersion: host.pi.version });

const startProxy = async (deps: CliDeps, context: LaunchContext, host: HostSide) => {
  try {
    return await deps.proxy.ensure({
      config: context.effective.config,
      stateDir: context.stateDir,
      env: daemonEnv(deps.env),
      home: deps.home,
      piCommand: host.pi?.command ?? [],
      ...hostPiOf(host),
    });
  } catch (error) {
    throw new LauncherError(
      `the egress proxy could not start, refusing to run without it: ${errorMessage(error)}`,
      error instanceof LauncherError && error.hint !== undefined ? error.hint : "run pi sandbox doctor",
    );
  }
};

const dynamicOf = (host: HostSide, tokenHash: string): ProxyDynamic => ({
  rules: host.derived.rules,
  derivedHosts: host.derived.hosts,
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
): Promise<SandboxProxy | undefined> => {
  if (!host.proxyNeeded) {
    return undefined;
  }

  const instance = await startProxy(deps, context, host);
  const repoToken = await repoProxyToken(context.stateDir, instance.policyHash, context.repoHash);
  const tokenHash = sha256Hex(repoToken);

  await writeProxyDynamic(context.stateDir, instance.policyHash, dynamicOf(host, tokenHash));

  await handEnvSecrets(deps, context, host, { instance, tokenHash });

  return { instance, policyHash: instance.policyHash, repoToken };
};

const deniedTargets = (denials: DenialRecord[]) => [
  ...new Map(denials.map((denial) => [authorityOf(denial.host, denial.port), denial])).values(),
];

const denialLine = (grants: boolean) => (denial: DenialRecord) => {
  const target = authorityOf(denial.host, denial.port);

  return grants
    ? `pi-sandbox: ${target} was blocked; run pi sandbox egress allow ${target}`
    : `pi-sandbox: ${target} was blocked; egress grants are off, add it to egress.allow`;
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

  writeLines(deps.stderr, deniedTargets(denials).map(denialLine(context.effective.config.egress.grants)));
};

import { setTimeout as delay } from "node:timers/promises";
import { type SandboxConfig, vaultEnabled } from "../config/index.ts";
import {
  type DerivedSandboxPi,
  deriveSandboxPi,
  discoverVaultServers,
  type HostPi,
  type HostPiFiles,
  readHostPiFiles,
  readProviderHosts,
  seedMcpAuth,
  vaultCandidates,
} from "../hostpi/index.ts";
import { privateHostNotices, type TrustBundle } from "../proxy/index.ts";
import { ensureSalt } from "../shared/index.ts";
import { type CliDeps, hostAgentDirOf, settleAll, writeNotices } from "./deps.ts";
import { resolveJobPi } from "./host-pi.ts";
import type { LaunchContext } from "./launch.ts";

export interface HostSide {
  hostAgentDir: string;
  files: HostPiFiles;
  pi?: HostPi;
  derived: DerivedSandboxPi;
  trust?: TrustBundle;
  proxyNeeded: boolean;
}

const DNS_WAIT_MS = 2000;

const MISSING_PI =
  "no pi on the host, built-in providers get no credential rules; install pi or reinstall the launcher with npm install -g pi-extensions-mz";

const needsProxy = (config: SandboxConfig) => config.egress.allow.length > 0;

export const providerHostsOf = async (deps: CliDeps, stateDir: string, pi: HostPi | undefined) => {
  if (pi === undefined) {
    return { hosts: {}, notices: [MISSING_PI] };
  }

  return readProviderHosts({ stateDir, runner: deps.runner, pi });
};

export const discoverVault = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
  pi: HostPi | undefined,
) => {
  const candidates = vaultCandidates(files.mcp ?? {});

  if (!vaultEnabled(context.effective.config) || pi === undefined || Object.keys(candidates).length === 0) {
    return { discovery: {}, notices: [] };
  }

  return discoverVaultServers({
    stateDir: context.stateDir,
    runner: deps.runner,
    pi,
    candidates,
    now: deps.now,
  });
};

const deriveFor = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
  pi: HostPi | undefined,
) => {
  const { config } = context.effective;
  const [seeded, providers, vault, salt] = await settleAll([
    seedMcpAuth({ stateDir: context.stateDir, files }),
    providerHostsOf(deps, context.stateDir, pi),
    discoverVault(deps, context, files, pi),
    ensureSalt(context.stateDir),
  ]);
  const derived = deriveSandboxPi({
    files,
    providerHosts: providers.hosts,
    manual: config.credentials.rules,
    salt,
    env: deps.env,
    derive: config.credentials.derive,
    mcpSignedIn: seeded.signedIn,
    vault: { enabled: vaultEnabled(config), discovery: vault.discovery },
  });

  return { derived, notices: [...providers.notices, ...vault.notices, ...derived.notices] };
};

export const deriveVaultServers = async (deps: CliDeps, context: LaunchContext) => {
  const [files, pi] = await Promise.all([readHostPiFiles(hostAgentDirOf(deps)), resolveJobPi(deps)]);
  const { derived } = await deriveFor(deps, context, files, pi);

  return derived.vault;
};

const HOST_STORE_SKIPPED =
  "tls.extraCa hostStore reads the macOS System keychain only and was skipped here; list the CA with { file } instead";

const hostStoreNotices = (deps: CliDeps, context: LaunchContext) =>
  deps.platform !== "darwin" && context.effective.config.tls.extraCa.some((source) => "hostStore" in source)
    ? [HOST_STORE_SKIPPED]
    : [];

const trustFor = (deps: CliDeps, context: LaunchContext, derived: DerivedSandboxPi, proxyNeeded: boolean) => {
  const sources = context.effective.config.tls.extraCa;

  if (!proxyNeeded || (derived.rules.length === 0 && sources.length === 0)) {
    return undefined;
  }

  return deps.proxy.trust(context.stateDir, sources);
};

const noticesWithin = async (pending: Promise<string[]>) => {
  const abort = new AbortController();
  const late = delay(DNS_WAIT_MS, [], { signal: abort.signal }).catch(() => []);

  try {
    return await Promise.race([pending, late]);
  } finally {
    abort.abort();
  }
};

export const prepareHostSide = async (
  deps: CliDeps,
  context: LaunchContext,
  pi: HostPi | undefined,
): Promise<HostSide> => {
  const { config } = context.effective;
  const hostAgentDir = hostAgentDirOf(deps);
  const files = await readHostPiFiles(hostAgentDir);
  const { derived, notices } = await deriveFor(deps, context, files, pi);
  const proxyNeeded = needsProxy(config) || derived.rules.length > 0;
  const [privateNotices, trust] = await settleAll([
    noticesWithin(
      privateHostNotices({
        rules: derived.rules,
        privateHosts: config.egress.privateHosts,
        resolve: deps.resolveHost,
      }),
    ),
    trustFor(deps, context, derived, proxyNeeded),
  ]);

  writeNotices(deps, [...notices, ...privateNotices, ...hostStoreNotices(deps, context)]);

  return { hostAgentDir, files, pi, derived, trust, proxyNeeded };
};

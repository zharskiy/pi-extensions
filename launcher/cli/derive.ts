import { LEGACY_GATEWAY_RULE_ID, type SandboxConfig, vaultEnabled } from "../config/index.ts";
import {
  type DerivedSandboxPi,
  deriveSandboxPi,
  discoverVaultServers,
  type HostPiFiles,
  privateHostNotices,
  readHostPiFiles,
  readProviderHosts,
  seedMcpAuth,
  vaultCandidates,
} from "../hostpi/index.ts";
import type { TrustBundle } from "../proxy/index.ts";
import { ensureSalt, sha256Hex } from "../shared/index.ts";
import { type CliDeps, hostAgentDirOf, writeNotices } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";
import { piVersion } from "./versions.ts";

export interface HostSide {
  repoHash: string;
  hostAgentDir: string;
  files: HostPiFiles;
  derived: DerivedSandboxPi;
  trust?: TrustBundle;
  proxyNeeded: boolean;
}

const MISSING_PI =
  "the launcher's bundled pi is missing, built-in providers get no credential rules; reinstall with npm install -g pi-extensions-mz";

const needsProxy = (config: SandboxConfig) =>
  config.gateway !== undefined || config.egress.allow.length > 0 || config.egress.mcpHosts.length > 0;

export const providerHostsOf = async (deps: CliDeps, stateDir: string) => {
  const pi = await deps.bundledPi();

  if (pi === undefined) {
    return { hosts: {}, notices: [MISSING_PI] };
  }

  return readProviderHosts({ stateDir, runner: deps.runner, pi, imagePiVersion: await piVersion() });
};

export const discoverVault = async (deps: CliDeps, context: LaunchContext, files: HostPiFiles) => {
  const candidates = vaultCandidates(files.mcp ?? {});
  const pi = await deps.bundledPi();

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

const deriveFor = async (deps: CliDeps, context: LaunchContext, files: HostPiFiles) => {
  const { config } = context.effective;
  const seeded = await seedMcpAuth({ stateDir: context.stateDir, files });
  const providers = await providerHostsOf(deps, context.stateDir);
  const vault = await discoverVault(deps, context, files);
  const derived = deriveSandboxPi({
    files,
    providerHosts: providers.hosts,
    gateway: config.gateway,
    credentials: config.credentials,
    manual: config.credentials.rules,
    salt: await ensureSalt(context.stateDir),
    env: deps.env,
    derive: config.credentials.derive,
    mcpSignedIn: seeded.signedIn,
    vault: { enabled: vaultEnabled(config), discovery: vault.discovery },
  });

  return { derived, notices: [...providers.notices, ...vault.notices, ...derived.notices] };
};

export const deriveVaultServers = async (deps: CliDeps, context: LaunchContext) => {
  const files = await readHostPiFiles(hostAgentDirOf(deps));
  const { derived } = await deriveFor(deps, context, files);

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

export const prepareHostSide = async (deps: CliDeps, context: LaunchContext): Promise<HostSide> => {
  const { config } = context.effective;
  const hostAgentDir = hostAgentDirOf(deps);
  const files = await readHostPiFiles(hostAgentDir);
  const { derived, notices } = await deriveFor(deps, context, files);
  const privateNotices = await privateHostNotices({
    rules: derived.rules.filter((rule) => rule.id !== LEGACY_GATEWAY_RULE_ID),
    privateHosts: config.egress.privateHosts,
    resolve: deps.resolveHost,
  });

  writeNotices(deps, [...notices, ...privateNotices, ...hostStoreNotices(deps, context)]);

  const proxyNeeded = needsProxy(config) || derived.rules.length > 0;

  return {
    repoHash: sha256Hex(context.workspace.repoRoot),
    hostAgentDir,
    files,
    derived,
    trust: await trustFor(deps, context, derived, proxyNeeded),
    proxyNeeded,
  };
};

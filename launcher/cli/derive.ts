import { setTimeout as delay } from "node:timers/promises";
import { egressAllowList, type SandboxConfig } from "../config/index.ts";
import {
  type DerivedSandboxPi,
  deriveHostTools,
  deriveSandboxPi,
  type HostPi,
  type HostPiFiles,
  readProviderHosts,
} from "../hostpi/index.ts";
import { privateHostNotices, type TrustBundle } from "../proxy/index.ts";
import { ensureSalt, settleAll } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf } from "./deps.ts";
import { sandboxRoots } from "./host-pi.ts";

export interface HostSide {
  hostAgentDir: string;
  files: HostPiFiles;
  pi?: HostPi;
  derived: DerivedSandboxPi;
  trust?: TrustBundle;
  proxyNeeded: boolean;
}

export interface PreparedHost {
  host: HostSide;
  notices: string[];
  privateNotices: Promise<string[]>;
}

const DNS_WAIT_MS = 2000;

const MISSING_PI =
  "no pi on the host, built-in providers get no credential rules; install pi or reinstall the launcher with npm install -g pi-extensions-mz";

const needsProxy = (config: SandboxConfig) => egressAllowList(config.egress).length > 0;

export const providerHostsOf = async (deps: CliDeps, stateDir: string, pi: HostPi | undefined) => {
  if (pi === undefined) {
    return { hosts: {}, notices: [MISSING_PI] };
  }

  return readProviderHosts({ stateDir, runner: deps.runner, pi });
};

const deriveFor = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
  pi: HostPi | undefined,
) => {
  const { config } = context.effective;
  const salting = ensureSalt(context.stateDir);
  const [providers, salt, tools] = await settleAll([
    providerHostsOf(deps, context.stateDir, pi),
    salting,
    salting.then((salt) =>
      deriveHostTools({
        home: deps.home,
        env: deps.env,
        platform: deps.platform,
        runner: deps.runner,
        salt,
        enabled: config.credentials.derive.enabled,
        excludedRoots: sandboxRoots(deps, context),
      }),
    ),
  ]);
  const derived = deriveSandboxPi({
    files,
    tools,
    providerHosts: providers.hosts,
    manual: config.credentials.rules,
    salt,
    env: deps.env,
    derive: config.credentials.derive,
  });

  return { derived, notices: [...providers.notices, ...derived.notices] };
};

const HOST_STORE_SKIPPED =
  "tls.extraCa hostStore reads the macOS System keychain only and was skipped here; list the CA with { file } instead";

const hostStoreNotices = (deps: CliDeps, context: LaunchContext) =>
  deps.platform !== "darwin" && context.effective.config.tls.extraCa.some((source) => "hostStore" in source)
    ? [HOST_STORE_SKIPPED]
    : [];

const trustFor = (deps: CliDeps, context: LaunchContext, proxyNeeded: boolean) =>
  proxyNeeded ? deps.proxy.trust(context.stateDir, context.effective.config.tls.extraCa) : undefined;

const noticesWithin = async (pending: Promise<string[]>, waitMs: number) => {
  const abort = new AbortController();
  const late = delay(waitMs, [], { signal: abort.signal }).catch(() => []);

  try {
    return await Promise.race([pending, late]);
  } finally {
    abort.abort();
  }
};

export const prepareHostSide = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
  pi: HostPi | undefined,
): Promise<PreparedHost> => {
  const { config } = context.effective;
  const { derived, notices } = await deriveFor(deps, context, files, pi);
  const proxyNeeded = needsProxy(config) || derived.rules.length > 0;
  const privateNotices = noticesWithin(
    privateHostNotices({
      rules: derived.rules,
      privateHosts: config.egress.privateHosts,
      resolve: deps.resolveHost,
    }),
    deps.dnsWaitMs ?? DNS_WAIT_MS,
  )
    .then((lines) => lines.map((notice) => `pi-sandbox: ${notice}`))
    .catch(() => []);
  const trust = await trustFor(deps, context, proxyNeeded);

  return {
    host: { hostAgentDir: hostAgentDirOf(deps), files, pi, derived, trust, proxyNeeded },
    notices: [...notices, ...hostStoreNotices(deps, context)],
    privateNotices,
  };
};

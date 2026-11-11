import { egressAllowList } from "../config/index.ts";
import {
  type DerivedSandboxPi,
  deriveHostTools,
  deriveSandboxPi,
  type HostPi,
  type HostPiFiles,
  readProviderHosts,
} from "../hostpi/index.ts";
import type { TrustBundle } from "../proxy/index.ts";
import { ensureSalt, settleAll } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf } from "./deps.ts";
import { missingPiText, sandboxRoots } from "./host-pi.ts";

export interface HostSide {
  hostAgentDir: string;
  files: HostPiFiles;
  pi?: HostPi;
  derived: DerivedSandboxPi;
  trust: TrustBundle;
}

export interface PreparedHost {
  host: HostSide;
  notices: string[];
}

export const providerHostsOf = async (deps: CliDeps, context: LaunchContext, pi: HostPi | undefined) => {
  if (pi === undefined) {
    return { hosts: {}, notices: [missingPiText(deps)] };
  }

  return readProviderHosts({ stateDir: context.stateDir, runner: deps.runner, pi });
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
    providerHostsOf(deps, context, pi),
    salting,
    salting.then((salt) =>
      deriveHostTools({
        home: deps.home,
        env: deps.env,
        platform: deps.platform,
        runner: deps.runner,
        salt,
        enabled: config.credentials.derive.enabled,
        excludedRoots: sandboxRoots(context),
      }),
    ),
  ]);
  const derived = deriveSandboxPi({
    files,
    tools,
    providerHosts: providers.hosts,
    manual: config.credentials.rules,
    egress: egressAllowList(config.egress),
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

export const prepareHostSide = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
  pi: HostPi | undefined,
): Promise<PreparedHost> => {
  const [{ derived, notices }, trust] = await settleAll([
    deriveFor(deps, context, files, pi),
    deps.proxy.trust(context.stateDir, context.effective.config.tls.extraCa),
  ]);

  return {
    host: { hostAgentDir: hostAgentDirOf(deps), files, pi, derived, trust },
    notices: [...notices, ...hostStoreNotices(deps, context)],
  };
};

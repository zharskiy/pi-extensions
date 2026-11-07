import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { connect } from "node:net";
import { orgBaselineStatus, type ParentProxy, vaultEnabled } from "../../config/index.ts";
import { failed, passed, skipped } from "../../container/index.ts";
import { type HostPiFiles, readHostPiFiles } from "../../hostpi/index.ts";
import {
  errorMessage,
  mcpAuthKey,
  readVaultStore,
  type VaultDiscovery,
  type VaultEntry,
} from "../../shared/index.ts";
import { assertHostSessionsDir } from "../../workspace/index.ts";
import { type CliDeps, hostAgentDirOf } from "../deps.ts";
import { discoverVault, providerHostsOf } from "../derive.ts";
import { hostSessionsOf } from "../host-sessions.ts";
import type { LaunchContext } from "../launch.ts";
import { piVersion } from "../versions.ts";
import type { NamedCheck } from "./doctor-container.ts";
import { grantLines } from "./egress.ts";

const CONNECT_TIMEOUT_MS = 3000;

const MINUTE_MS = 60_000;

const HOUR_MS = 3_600_000;

const DAY_MS = 86_400_000;

const MINUTES_SHOWN_BELOW_MS = 2 * HOUR_MS;

const HOURS_SHOWN_BELOW_MS = 2 * DAY_MS;

const DEFAULT_PROXY_PORT = 80;

const checkBundledPi = async (deps: CliDeps) => {
  const bundled = await deps.bundledPi();

  if (bundled === undefined) {
    return failed("no pi next to the launcher; reinstall it with npm install -g pi-extensions-mz");
  }

  const pinned = await piVersion();

  return bundled.version === pinned
    ? passed(`pi ${bundled.version}, the same as the image`)
    : failed(`the launcher's pi ${bundled.version} differs from the image pi ${pinned}`);
};

const checkProviderHosts = async (deps: CliDeps, context: LaunchContext) => {
  const { hosts, notices } = await providerHostsOf(deps, context.stateDir);
  const count = Object.keys(hosts).length;

  return count > 0
    ? passed(`${count} built-in providers with known hosts`)
    : failed(notices[0] ?? "the provider host table is empty");
};

const parentUrl = (parent: ParentProxy, env: NodeJS.ProcessEnv) => {
  if (parent === "none") {
    return undefined;
  }

  return parent === "env" ? (env.HTTPS_PROXY ?? env.https_proxy) : parent.url;
};

const reachable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });

    socket.once("connect", () => {
      socket.destroy();

      resolve(true);
    });

    socket.once("timeout", () => {
      socket.destroy();

      resolve(false);
    });

    socket.once("error", () => resolve(false));
  });

const parsedUrl = (text: string) => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

const checkParentProxy = async (deps: CliDeps, context: LaunchContext) => {
  const text = parentUrl(context.effective.config.egress.parentProxy, deps.env);

  if (text === undefined || text === "") {
    return skipped("no parent proxy configured");
  }

  const url = parsedUrl(text);

  if (url === undefined) {
    return failed("the parent proxy URL does not parse");
  }

  const authority = `${url.hostname}:${url.port || DEFAULT_PROXY_PORT}`;

  return (await reachable(url.hostname, Number(url.port || DEFAULT_PROXY_PORT)))
    ? passed(`${authority} accepts connections`)
    : failed(`${authority} does not accept connections`);
};

const checkOrg = async (deps: CliDeps, context: LaunchContext) => {
  const ref = context.effective.config.org;

  if (ref === undefined) {
    return skipped("no org baseline configured");
  }

  const status = await orgBaselineStatus({
    ref,
    stateDir: context.stateDir,
    now: deps.now,
    home: deps.home,
  });

  return status.ok ? passed(status.message) : failed(status.message);
};

const checkGrants = async (deps: CliDeps, context: LaunchContext) => {
  if (!context.effective.config.egress.grants.enabled) {
    return passed("turned off by egress.grants.enabled");
  }

  const lines = await grantLines(deps, context);

  return passed(lines.length === 0 ? "none active" : `${lines.length} active: ${lines.join("; ")}`);
};

const durationText = (ms: number) => {
  if (ms < MINUTES_SHOWN_BELOW_MS) {
    return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  }

  return ms < HOURS_SHOWN_BELOW_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / DAY_MS)} days`;
};

const signInText = (deps: CliDeps, name: string, entry: VaultEntry | undefined) => {
  const tokens = entry?.tokens;

  if (tokens === undefined || (tokens.access_token === undefined && tokens.refresh_token === undefined)) {
    return `not signed in; sign in from /mcp in pi, or with pi mcp login ${name} in the shell`;
  }

  if (entry?.tokensExpireAt === undefined) {
    return "signed in";
  }

  const left = entry.tokensExpireAt - deps.now();

  return left > 0
    ? `signed in, token expires in ${durationText(left)}`
    : "signed in, token expired, the proxy refreshes it";
};

const vaultCheck = (
  deps: CliDeps,
  discovery: VaultDiscovery,
  store: Record<string, VaultEntry>,
): NamedCheck => {
  const name = `mcp ${discovery.server}`;

  if (!discovery.ok) {
    return { name, result: failed(`vault discovery failed: ${discovery.error}`) };
  }

  const ready = `vault ready (authorization server ${new URL(discovery.issuer).host})`;
  const entry = store[mcpAuthKey(discovery.server, discovery.url)];

  return { name, result: passed(`${ready}, ${signInText(deps, discovery.server, entry)}`) };
};

const vaultChecks = async (
  deps: CliDeps,
  context: LaunchContext,
  files: HostPiFiles,
): Promise<NamedCheck[]> => {
  if (!vaultEnabled(context.effective.config)) {
    return [
      {
        name: "mcp vault",
        result: skipped("turned off by credentials.vault.enabled or credentials.derive.enabled"),
      },
    ];
  }

  const { discovery } = await discoverVault(deps, context, files);
  const store = await readVaultStore(context.stateDir);

  return Object.values(discovery).map((found) => vaultCheck(deps, found, store));
};

const unsafeSessionsDir = (deps: CliDeps, context: LaunchContext, dir: string) => {
  try {
    assertHostSessionsDir(dir, {
      home: deps.home,
      agentDir: hostAgentDirOf(deps),
      repoRoot: context.workspace.repoRoot,
    });

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const checkSessions = async (deps: CliDeps, context: LaunchContext, files: HostPiFiles) => {
  const sessions = hostSessionsOf(deps, context, files.settings);

  if ("off" in sessions) {
    return skipped(`in the sandbox volume (${sessions.off})`);
  }

  if ((await lstat(sessions.dir).catch(() => undefined)) === undefined) {
    return passed(`${sessions.dir} (host pi lists them, created at the first launch)`);
  }

  const unsafe = unsafeSessionsDir(deps, context, sessions.dir);

  if (unsafe !== undefined) {
    return failed(unsafe);
  }

  const writable = await access(sessions.dir, constants.W_OK).then(
    () => true,
    () => false,
  );

  return writable
    ? passed(`${sessions.dir} (host pi lists them)`)
    : failed(`${sessions.dir} is not writable`);
};

const named = async (name: string, result: Promise<NamedCheck["result"]>): Promise<NamedCheck> => ({
  name,
  result: await result,
});

export const hostChecks = async (deps: CliDeps, context: LaunchContext): Promise<NamedCheck[]> => {
  const files = await readHostPiFiles(hostAgentDirOf(deps));
  const [checks, vault] = await Promise.all([
    Promise.all([
      named("bundled pi", checkBundledPi(deps)),
      named("provider hosts", checkProviderHosts(deps, context)),
      named("parent proxy", checkParentProxy(deps, context)),
      named("org baseline", checkOrg(deps, context)),
      named("grants", checkGrants(deps, context)),
      named("sessions", checkSessions(deps, context, files)),
    ]),
    vaultChecks(deps, context, files),
  ]);

  return [...checks, ...vault];
};

import { listenFor } from "../container/index.ts";
import type { HostPi, McpOAuthServer } from "../hostpi/index.ts";
import {
  isFreshMcpToken,
  mcpAuthKey,
  mcpLoginCommand,
  readMcpAuthEntry,
  readMcpLogins,
  stateLayout,
  updateMcpLogin,
  withFileLockIfFree,
} from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, isTerminal, writeNotices } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import { hostPiEnv, runHostJob } from "./host-pi.ts";
import { writeOnce } from "./notices.ts";

const FAILURE_QUIET_MS = 24 * 60 * 60_000;

const notice = (deps: CliDeps, name: string, text: string) => {
  writeNotices(deps, [`mcp ${name}: ${text}`]);
};

const notSignedInLine = (name: string) => `mcp ${name}: not signed in; run pi mcp login ${name}`;

const notSignedIn = (deps: CliDeps, context: LaunchContext, name: string) =>
  writeOnce(deps, context, [notSignedInLine(name)]);

const needsSignIn = async (host: HostSide, server: McpOAuthServer, now: number) => {
  const entry = await readMcpAuthEntry(host.hostAgentDir, server.name, server.url);

  return entry?.refresh === undefined && !isFreshMcpToken(entry, now);
};

const runLogin = async (deps: CliDeps, pi: HostPi, server: McpOAuthServer) => {
  const keepAlive = listenFor(deps.signals ?? process, ["SIGINT"]);

  try {
    return await runHostJob(deps, mcpLoginCommand(pi.command, server.name), "empty", hostPiEnv(deps));
  } finally {
    keepAlive.stop();
  }
};

const signInOnce = async (deps: CliDeps, context: LaunchContext, host: HostSide, server: McpOAuthServer) => {
  const key = mcpAuthKey(server.name, server.url);
  const failedAt = (await readMcpLogins(context.stateDir))[key]?.failedAt;

  if (host.pi === undefined || (failedAt !== undefined && deps.now() - failedAt < FAILURE_QUIET_MS)) {
    return false;
  }

  await updateMcpLogin(context.stateDir, key, (current) => ({ ...current, lastStart: deps.now() }));

  notice(deps, server.name, "signing in on the host; your browser opens");

  const code = await runLogin(deps, host.pi, server);

  await updateMcpLogin(context.stateDir, key, ({ failedAt: _failed, ...rest }) =>
    code === 0 ? rest : { ...rest, failedAt: deps.now() },
  );

  return code === 0;
};

const signIn = async (deps: CliDeps, context: LaunchContext, host: HostSide, server: McpOAuthServer) => {
  const lock = stateLayout(context.stateDir).mcpLoginLock(mcpAuthKey(server.name, server.url));
  const outcome = await withFileLockIfFree(lock, () => signInOnce(deps, context, host, server));

  if (outcome.busy) {
    notice(deps, server.name, "a sign-in is already open on the host");

    return;
  }

  if (!outcome.value) {
    await notSignedIn(deps, context, server.name);
  }
};

export const signInMcpServers = async (deps: CliDeps, context: LaunchContext, host: HostSide) => {
  const servers = host.derived.oauthServers;
  const flags = await Promise.all(servers.map((server) => needsSignIn(host, server, deps.now())));
  const needed = servers.filter((_, index) => flags[index]);

  if (!isTerminal(deps.terminal.stdin) || !isTerminal(deps.terminal.stdout)) {
    await writeOnce(
      deps,
      context,
      needed.map((server) => notSignedInLine(server.name)),
    );

    return;
  }

  await needed.reduce(
    (previous, server) =>
      previous.then(() =>
        signIn(deps, context, host, server).catch(() => notSignedIn(deps, context, server.name)),
      ),
    Promise.resolve(),
  );
};

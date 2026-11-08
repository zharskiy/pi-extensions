import { rm } from "node:fs/promises";
import { type HostPi, type McpOAuthServer, mcpSignInsNeeded } from "../hostpi/index.ts";
import {
  makeMcpLoginDir,
  mcpAuthKey,
  mcpLoginCommand,
  PI_AGENT_DIR_VARIABLE,
  readMcpLogins,
  stateLayout,
  updateMcpLogin,
  withFileLockIfFree,
} from "../shared/index.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import type { HostSide } from "./derive.ts";
import type { LaunchContext } from "./launch.ts";

const LOGIN_TIMEOUT_SECONDS = 120;

const FAILURE_QUIET_MS = 24 * 60 * 60_000;

const notice = (deps: CliDeps, name: string, text: string) => {
  writeLine(deps.stderr, `pi-sandbox: mcp ${name}: ${text}`);
};

const notSignedIn = (deps: CliDeps, name: string) => {
  notice(deps, name, `not signed in; run pi mcp login ${name}`);
};

const derivedServers = (host: HostSide) =>
  new Set(
    host.derived.rules.flatMap((rule) => ("mcpOAuth" in rule.secret ? [rule.secret.mcpOAuth.server] : [])),
  );

const runLogin = async (deps: CliDeps, stateDir: string, pi: HostPi, server: McpOAuthServer) => {
  const [file = "", ...args] = mcpLoginCommand(pi.command, server.name, LOGIN_TIMEOUT_SECONDS);
  const cwd = await makeMcpLoginDir(stateDir);
  const signals = deps.signals ?? process;
  const keepAlive = () => undefined;

  signals.on("SIGINT", keepAlive);

  try {
    return await deps.runner.spawnInteractive(file, args, {
      cwd,
      env: { [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) },
    });
  } finally {
    signals.off("SIGINT", keepAlive);

    await rm(cwd, { recursive: true, force: true });
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

  const code = await runLogin(deps, context.stateDir, host.pi, server);

  if (code !== 0) {
    await updateMcpLogin(context.stateDir, key, (current) => ({ ...current, failedAt: deps.now() }));
  }

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
    notSignedIn(deps, server.name);
  }
};

export const signInMcpServers = async (deps: CliDeps, context: LaunchContext, host: HostSide) => {
  const derived = derivedServers(host);
  const needed = (await mcpSignInsNeeded(host.files, deps.now())).filter((server) =>
    derived.has(server.name),
  );

  if (deps.terminal.stdin.isTTY !== true) {
    needed.forEach((server) => {
      notSignedIn(deps, server.name);
    });

    return;
  }

  await needed.reduce(
    (previous, server) =>
      previous.then(() => signIn(deps, context, host, server).catch(() => notSignedIn(deps, server.name))),
    Promise.resolve(),
  );
};

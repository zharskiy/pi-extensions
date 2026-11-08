import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findRepoContainer } from "../container/index.ts";
import { type HostPi, mcpLoginServer, oneServerDir, prepareMcpLogin } from "../hostpi/index.ts";
import { expandHome, isWithin, LauncherError } from "../shared/index.ts";
import { mountedGitDirs } from "../workspace/index.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import { deriveVaultServers } from "./derive.ts";
import { interactiveCommand, nearbyRoots, resolveJobPi, resolveShellPi, type ShellPi } from "./host-pi.ts";
import { type LaunchContext, openBackend, openContext } from "./launch.ts";
import { syncSandboxMcpAuth } from "./mcp-auth-sync.ts";

const SELF_UPDATE_HINT = "update it with npm install -g pi-extensions-mz";

const SELF_UPDATE = `pi follows the launcher; ${SELF_UPDATE_HINT}`;

const LOCAL_FLAGS = ["-l", "--local"];

const piOnHost = async (deps: CliDeps) => {
  const pi = await resolveJobPi(deps);

  if (pi === undefined) {
    throw new LauncherError(
      "no pi on the host to run this with",
      "install pi or reinstall the launcher with npm install -g pi-extensions-mz",
    );
  }

  return pi.command;
};

const runOnHost = async (
  deps: CliDeps,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => {
  const [file = "", ...prefix] = await piOnHost(deps);

  return deps.runner.spawnInteractive(file, [...prefix, ...args], options);
};

const LOCAL_SOURCE = /^(\/|\.|~)/;

const realOf = (path: string) => realpath(path).catch(() => path);

const inRepository = async (deps: CliDeps, source: string) => {
  const context = await openContext(deps, { lenient: true });
  const path = resolve(context.workspace.cwd, expandHome(source, deps.home));
  const candidates = [path, await realOf(path)];
  const roots = await Promise.all(mountedGitDirs(context.workspace).map(realOf));

  return roots.some((root) => candidates.some((candidate) => isWithin(candidate, root)));
};

const packageCommand = async (deps: CliDeps, argv: string[], source: string) => {
  if (argv[0] === "install" && LOCAL_SOURCE.test(source) && (await inRepository(deps, source))) {
    writeLine(
      deps.stderr,
      `pi-sandbox: ${source} lies in the repository, which the sandbox can rewrite; not installed on the host`,
    );

    return 1;
  }

  return runOnHost(deps, argv, { cwd: deps.cwd });
};

const confirmProjectServer = (deps: CliDeps, name: string) => () =>
  deps.confirm(
    `pi-sandbox: mcp ${name} is defined only in this repository's .pi/mcp.json, which the sandbox can write; sign in to it on the host? [y/N] `,
  );

const loginDir = async (deps: CliDeps, context: LaunchContext, action: string, name: string) => {
  const stateDir = context.stateDir;

  if (action === "logout") {
    return oneServerDir(stateDir, name);
  }

  const server = await mcpLoginServer({
    name,
    hostAgentDir: hostAgentDirOf(deps),
    projectMcpFile: join(context.workspace.repoRoot, ".pi", "mcp.json"),
    confirm: confirmProjectServer(deps, name),
  });

  return (await prepareMcpLogin({ stateDir, name, server })).agentDir;
};

const runningContainer = async (deps: CliDeps, context: LaunchContext) => {
  const backend = await openBackend(deps, context.effective.config).catch(() => undefined);
  const found = backend === undefined ? undefined : await findRepoContainer(backend, context.workspace);

  return backend === undefined || found?.state !== "running" ? undefined : { backend, containerId: found.id };
};

const syncRunningSandbox = async (deps: CliDeps, context: LaunchContext) => {
  const running = await runningContainer(deps, context);

  if (running === undefined) {
    return;
  }

  await syncSandboxMcpAuth(deps, context, { ...running, servers: await deriveVaultServers(deps, context) });
};

const mcpAuthCommand = async (deps: CliDeps, action: string, name: string, flags: string[]) => {
  const context = await openContext(deps);
  const agentDir = await loginDir(deps, context, action, name);
  const code = await runOnHost(deps, ["mcp", action, name, ...flags], {
    cwd: agentDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
  });

  if (code === 0) {
    await syncRunningSandbox(deps, context);
  }

  return code;
};

const AUTH_VALUE_FLAGS: Record<string, string[]> = { login: ["--timeout"], logout: [] };

const splitAuthArgs = (action: string, args: string[]) => {
  const valueFlags = AUTH_VALUE_FLAGS[action] ?? [];
  const split = { names: [] as string[], flags: [] as string[], unknown: false };

  args.forEach((arg, index) => {
    if (valueFlags.includes(arg) || valueFlags.includes(args[index - 1] ?? "")) {
      split.flags.push(arg);

      return;
    }

    if (arg.startsWith("-")) {
      split.unknown ||= !LOCAL_FLAGS.includes(arg);

      return;
    }

    split.names.push(arg);
  });

  return split;
};

const mcpCommand = (deps: CliDeps, args: string[]) => {
  const [action, ...rest] = args;

  if (action === "add" || action === "remove") {
    return runOnHost(deps, ["mcp", ...args], { cwd: deps.cwd });
  }

  if (action !== "login" && action !== "logout") {
    return undefined;
  }

  const { names, flags, unknown } = splitAuthArgs(action, rest);
  const [name] = names;

  if (unknown || name === undefined || names.length !== 1) {
    return undefined;
  }

  return mcpAuthCommand(deps, action, name, flags);
};

const packageSource = (args: string[]) => {
  if (args.some((arg) => LOCAL_FLAGS.includes(arg))) {
    return undefined;
  }

  const sources = args.filter((arg) => !arg.startsWith("-"));

  return sources.length === 1 ? sources[0] : undefined;
};

const SELF_TARGETS = ["pi", "self", "--self"];

const isSelfUpdate = (args: string[]) =>
  args.length === 0 || (args.length === 1 && SELF_TARGETS.includes(args[0] ?? ""));

const followsText = (updated: ShellPi, followed: HostPi) =>
  followed.source === "managed"
    ? `the sandbox follows pi ${followed.version} at the next launch`
    : `the sandbox follows pi ${followed.version} next to the launcher, not ${updated.command.at(-1)}; ${SELF_UPDATE_HINT}`;

const selfUpdate = async (deps: CliDeps) => {
  const roots = await nearbyRoots(deps);
  const pi = await resolveShellPi(deps, roots);

  if (pi === undefined || pi.source === "bundled") {
    writeLine(deps.stdout, SELF_UPDATE);

    return 0;
  }

  const [file = "", ...prefix] = interactiveCommand(pi);
  const code = await deps.runner.spawnInteractive(file, [...prefix, "update"], { cwd: deps.cwd });
  const followed = code === 0 ? await resolveJobPi(deps) : undefined;

  if (followed !== undefined) {
    writeLine(deps.stderr, `pi-sandbox: ${followsText(pi, followed)}`);
  }

  return code;
};

export const intercept = (argv: string[], deps: CliDeps): Promise<number> | number | undefined => {
  const [command, ...rest] = argv;

  if (command === "install" || command === "remove") {
    const source = packageSource(rest);

    return source === undefined ? undefined : packageCommand(deps, argv, source);
  }

  if (command === "mcp") {
    return mcpCommand(deps, rest);
  }

  return command === "update" && isSelfUpdate(rest) ? selfUpdate(deps) : undefined;
};

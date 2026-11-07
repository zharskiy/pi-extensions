import { join, resolve } from "node:path";
import { mcpLoginServer, oneServerDir, prepareMcpLogin, writeBackPackageChange } from "../hostpi/index.ts";
import { packageChangeFor, readVolumeSettings } from "../provision/index.ts";
import { expandHome, isWithin, LauncherError } from "../shared/index.ts";
import { type CliDeps, hostAgentDirOf, writeLine } from "./deps.ts";
import { bundledPiCommand } from "./host-pi.ts";
import {
  type LaunchContext,
  openContext,
  openSandboxContext,
  runSandboxPi,
  type Sandbox,
  withSandbox,
} from "./launch.ts";

const SELF_UPDATE = "pi follows the launcher; update it with npm install -g pi-extensions-mz";

const LOCAL_FLAGS = ["-l", "--local"];

const LOCAL_SOURCE = /^(\/|\.|~)/;

const piOnHost = async (deps: CliDeps) => {
  const command = await bundledPiCommand(deps);

  if (command === undefined) {
    throw new LauncherError(
      "no pi on the host to run this with",
      "reinstall the launcher with npm install -g pi-extensions-mz",
    );
  }

  return command;
};

const runOnHost = async (
  deps: CliDeps,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => {
  const [file = "", ...prefix] = await piOnHost(deps);

  return deps.runner.spawnInteractive(file, [...prefix, ...args], options);
};

const mountedRoots = (context: LaunchContext) => [
  context.workspace.repoRoot,
  ...(context.workspace.gitCommonDir === undefined ? [] : [context.workspace.gitCommonDir]),
  ...context.effective.config.mounts.extraReadOnly.map((path) => resolve(context.workspace.repoRoot, path)),
];

const isContainerLocal = (deps: CliDeps, context: LaunchContext, source: string) => {
  if (!LOCAL_SOURCE.test(source)) {
    return false;
  }

  const path = resolve(deps.cwd, expandHome(source, deps.home));

  return !mountedRoots(context).some((root) => isWithin(path, root));
};

const writeBack = async (
  deps: CliDeps,
  context: LaunchContext,
  sandbox: Sandbox,
  source: string,
  before: Awaited<ReturnType<typeof readVolumeSettings>>,
) => {
  const change = packageChangeFor(
    before,
    await readVolumeSettings(sandbox.backend, sandbox.containerId),
    source,
  );

  if (change === undefined) {
    return;
  }

  const file = join(sandbox.host.hostAgentDir, "settings.json");

  if (isContainerLocal(deps, context, source)) {
    writeLine(deps.stderr, `pi-sandbox: ${source} is a path inside the sandbox, ${file} was left as it is`);

    return;
  }

  const { changed } = await writeBackPackageChange({
    hostAgentDir: sandbox.host.hostAgentDir,
    source,
    kind: change.kind,
    entry: change.entry,
  });

  if (changed) {
    writeLine(
      deps.stderr,
      `pi-sandbox: ${change.kind === "install" ? "added" : "removed"} ${source} in ${file}`,
    );
  }
};

const packageCommand = async (deps: CliDeps, argv: string[], source: string) => {
  const { context, backend } = await openSandboxContext(deps);

  return withSandbox(deps, context, backend, async (sandbox) => {
    const before = await readVolumeSettings(backend, sandbox.containerId);
    const code = await runSandboxPi(deps, context, sandbox, argv);

    if (code === 0) {
      await writeBack(deps, context, sandbox, source, before);
    }

    return code;
  });
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

const mcpAuthCommand = async (deps: CliDeps, action: string, name: string, flags: string[]) => {
  const context = await openContext(deps);
  const agentDir = await loginDir(deps, context, action, name);

  return runOnHost(deps, ["mcp", action, name, ...flags], {
    cwd: agentDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
  });
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

const selfUpdate = (deps: CliDeps) => {
  writeLine(deps.stdout, SELF_UPDATE);

  return 0;
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

  return command === "update" && rest.length === 0 ? selfUpdate(deps) : undefined;
};

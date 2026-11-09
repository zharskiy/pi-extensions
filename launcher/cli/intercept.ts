import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostPi } from "../hostpi/index.ts";
import {
  expandHome,
  isWithin,
  LauncherError,
  makeMcpLoginDir,
  PI_AGENT_DIR_VARIABLE,
} from "../shared/index.ts";
import { mountedGitDirs } from "../workspace/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeLine } from "./deps.ts";
import { interactiveCommand, nearbyRoots, resolveJobPi, resolveShellPi, type ShellPi } from "./host-pi.ts";
import { openContext } from "./launch.ts";

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
  const { context } = await openContext(deps, "host");
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

const MCP_HOST_ACTIONS = new Set(["add", "remove", "login", "logout"]);

const MCP_PROJECT_ACTIONS = new Set(["add", "remove"]);

const inEmptyDir = async <T>(deps: CliDeps, use: (cwd: string) => Promise<T>) => {
  const cwd = await makeMcpLoginDir(pathsOf(deps).stateDir);

  try {
    return await use(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const mcpCommand = (deps: CliDeps, args: string[]) => {
  const [action = ""] = args;

  if (!MCP_HOST_ACTIONS.has(action)) {
    return undefined;
  }

  const env = { [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) };

  if (MCP_PROJECT_ACTIONS.has(action)) {
    return runOnHost(deps, ["mcp", ...args], { cwd: deps.cwd, env });
  }

  return inEmptyDir(deps, (cwd) => runOnHost(deps, ["mcp", ...args], { cwd, env }));
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

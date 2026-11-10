import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostPi } from "../hostpi/index.ts";
import {
  expandHome,
  isWithin,
  LauncherError,
  PI_AGENT_DIR_VARIABLE,
  withMcpLoginDir,
} from "../shared/index.ts";
import { mountedGitDirs } from "../workspace/index.ts";
import { openContext } from "./context.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeLine } from "./deps.ts";
import { interactiveCommand, nearbyRoots, resolveJobPi, resolveShellPi, type ShellPi } from "./host-pi.ts";

const SELF_UPDATE_HINT = "update it with npm install -g pi-extensions-mz";

const SELF_UPDATE = `pi follows the launcher; ${SELF_UPDATE_HINT}`;

const LOCAL_FLAGS = ["-l", "--local"];

const piOnHost = async (deps: CliDeps) => {
  const pi = await resolveJobPi(deps, await nearbyRoots(deps));

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

const NPM_PREFIX = "npm:";

const NPM_SPEC = /^(@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(@[A-Za-z0-9.^~<>=|*+ -]+)?$/;

const GIT_PREFIX = /^git:(?!\/\/)/;

const GIT_PART = /^[A-Za-z0-9._-]+$/;

const GIT_HOST = /^[A-Za-z0-9.-]+$/;

const GIT_REF = /^[A-Za-z0-9._/-]+$/;

const SCP_SOURCE = /^git@([^:]+):(.+)$/;

const SHORT_SOURCE = /^([^/]+)\/(.+)$/;

const FILE_URL = /^file:\/\//;

const isRepoPath = (path: string) => {
  const parts = path.replace(/\.git$/, "").split("/");

  return parts.length >= 2 && parts.every((part) => GIT_PART.test(part) && part !== "." && part !== "..");
};

const withoutRef = (path: string) => {
  const [repo = "", ref] = path.split("@", 2);

  return ref === undefined || GIT_REF.test(ref) ? repo : undefined;
};

const isGitPath = (host: string, path: string) => {
  const repo = withoutRef(path);

  return GIT_HOST.test(host) && repo !== undefined && isRepoPath(repo);
};

const isGitUrl = (text: string) => {
  try {
    const url = new URL(text);
    const ref = url.hash.slice(1);

    return (
      ["https:", "http:", "ssh:"].includes(url.protocol) &&
      url.search === "" &&
      (ref === "" || GIT_REF.test(ref)) &&
      isGitPath(url.hostname, url.pathname.replace(/^\/+/, ""))
    );
  } catch {
    return false;
  }
};

const isPrefixedGitShorthand = (text: string) => {
  const scp = SCP_SOURCE.exec(text);
  const short = scp === null ? SHORT_SOURCE.exec(text) : null;

  if (scp !== null) {
    return isGitPath(scp[1] ?? "", scp[2] ?? "");
  }

  return short !== null && (short[1] ?? "").includes(".") && isGitPath(short[1] ?? "", short[2] ?? "");
};

const isGitSource = (source: string) => {
  const text = source.trim();

  if (!GIT_PREFIX.test(text)) {
    return /^(https?|ssh):\/\//i.test(text) && isGitUrl(text);
  }

  const rest = text.slice("git:".length).trim();

  return /^(https?|ssh):\/\//i.test(rest) ? isGitUrl(rest) : isPrefixedGitShorthand(rest);
};

type PackageSource =
  | { kind: "remote" }
  | { kind: "refused"; reason: string }
  | { kind: "local"; text: string };

const classifySource = (source: string): PackageSource => {
  if (source.startsWith(NPM_PREFIX)) {
    return NPM_SPEC.test(source.slice(NPM_PREFIX.length).trim())
      ? { kind: "remote" }
      : { kind: "refused", reason: "is not a plain npm package name and version" };
  }

  return isGitSource(source) ? { kind: "remote" } : { kind: "local", text: source.trim() };
};

const localPathOf = (text: string) => {
  try {
    return FILE_URL.test(text) ? fileURLToPath(text) : text;
  } catch {
    return text;
  }
};

const realOf = (path: string) => realpath(path).catch(() => path);

const resolvedLocal = async (deps: CliDeps, text: string) => {
  const { context } = await openContext(deps, "host");
  const path = resolve(context.workspace.cwd, expandHome(localPathOf(text), deps.home));
  const candidates = [path, await realOf(path)];
  const roots = await Promise.all(mountedGitDirs(context.workspace).map(realOf));

  return {
    path,
    inRepository: roots.some((root) => candidates.some((candidate) => isWithin(candidate, root))),
  };
};

const refuse = (deps: CliDeps, source: string, reason: string) => {
  writeLine(deps.stderr, `pi-sandbox: ${source} ${reason}; not installed on the host`);

  return 1;
};

const IN_REPOSITORY = "lies in the repository, which the sandbox can rewrite";

const packageCommand = async (deps: CliDeps, argv: string[], source: string) => {
  const classified = classifySource(source);
  const [command = ""] = argv;

  if (classified.kind === "refused" && command === "install") {
    return refuse(deps, source, classified.reason);
  }

  const local = classified.kind === "local" ? await resolvedLocal(deps, classified.text) : undefined;

  if (local?.inRepository === true && command === "install") {
    return refuse(deps, source, IN_REPOSITORY);
  }

  const args = argv.map((arg) => (arg === source && local !== undefined ? local.path : arg));

  return withMcpLoginDir(pathsOf(deps).stateDir, (cwd) => runOnHost(deps, args, { cwd }));
};

const MCP_HOST_ACTIONS = new Set(["add", "remove", "login", "logout"]);

const MCP_PROJECT_ACTIONS = new Set(["add", "remove"]);

const mcpCommand = (deps: CliDeps, args: string[]) => {
  const [action = ""] = args;

  if (!MCP_HOST_ACTIONS.has(action)) {
    return undefined;
  }

  const env = { [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) };

  if (MCP_PROJECT_ACTIONS.has(action)) {
    return runOnHost(deps, ["mcp", ...args], { cwd: deps.cwd, env });
  }

  return withMcpLoginDir(pathsOf(deps).stateDir, (cwd) => runOnHost(deps, ["mcp", ...args], { cwd, env }));
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
  const followed = code === 0 ? await resolveJobPi(deps, roots) : undefined;

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

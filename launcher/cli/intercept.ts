import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEffectiveConfig } from "../config/index.ts";
import {
  expandHome,
  isWithin,
  knownRepos,
  PI_AGENT_DIR_VARIABLE,
  repoRecordOf,
  withMcpLoginDir,
} from "../shared/index.ts";
import { assertSafeMounts, findGitRoot } from "../workspace/index.ts";
import { type CliDeps, hostAgentDirOf, pathsOf, writeLine } from "./deps.ts";
import { requireJobPi, resolveJobPi } from "./host-pi.ts";
import { type HostRoute, hostRoute } from "./host-routes.ts";
import { imagePiVersion } from "./versions.ts";

const LOCAL_FLAGS = ["-l", "--local"];

const runOnHost = async (
  deps: CliDeps,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
) => {
  const pi = await requireJobPi(deps);

  return deps.runner.spawnInteractive(pi.wrapper, args, options);
};

const inEmptyDir = (deps: CliDeps, args: string[], options: { env?: Record<string, string> } = {}) =>
  withMcpLoginDir(pathsOf(deps).stateDir, (cwd) => runOnHost(deps, args, { ...options, cwd }));

const hostEnv = (deps: CliDeps) => ({ [PI_AGENT_DIR_VARIABLE]: hostAgentDirOf(deps) });

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

const GIT_PROTOCOLS = ["https:", "http:", "ssh:", "git:"];

const GIT_URL = /^(https?|ssh|git):\/\//i;

const isGitUrl = (text: string) => {
  try {
    const url = new URL(text);
    const ref = url.hash.slice(1);

    return (
      GIT_PROTOCOLS.includes(url.protocol) &&
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
    return GIT_URL.test(text) && isGitUrl(text);
  }

  const rest = text.slice("git:".length).trim();

  return GIT_URL.test(rest) ? isGitUrl(rest) : isPrefixedGitShorthand(rest);
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

const sandboxedRoots = async (stateDir: string) => {
  const records = await Promise.all((await knownRepos(stateDir)).map((hash) => repoRecordOf(stateDir, hash)));

  return Promise.all(records.flatMap((record) => (record === undefined ? [] : [realOf(record.root)])));
};

const canHoldSandbox = (deps: CliDeps, root: string) => {
  try {
    assertSafeMounts([root], { home: deps.home, env: deps.env });

    return true;
  } catch {
    return false;
  }
};

const isSandboxable = async (deps: CliDeps, candidates: string[]) => {
  const gitRoots = await Promise.all(candidates.map(findGitRoot));
  const roots = await sandboxedRoots(pathsOf(deps).stateDir);

  return (
    gitRoots.some((root) => root !== undefined && canHoldSandbox(deps, root)) ||
    roots.some((root) => candidates.some((candidate) => isWithin(candidate, root)))
  );
};

const resolvedLocal = async (deps: CliDeps, text: string) => {
  const path = resolve(deps.cwd, expandHome(localPathOf(text), deps.home));

  return { path, inRepository: await isSandboxable(deps, [path, await realOf(path)]) };
};

const refuse = (deps: CliDeps, source: string, reason: string) => {
  writeLine(deps.stderr, `pi-sandbox: ${source} ${reason}; not installed on the host`);

  return 1;
};

const IN_REPOSITORY = "lies in a git working tree or a sandboxed folder, which a sandbox can rewrite";

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

  return inEmptyDir(deps, args);
};

const MCP_HOST_ACTIONS = new Set(["add", "remove", "login", "logout"]);

const MCP_PROJECT_ACTIONS = new Set(["add", "remove"]);

const mcpCommand = (deps: CliDeps, args: string[]) => {
  const [action = ""] = args;

  if (!MCP_HOST_ACTIONS.has(action)) {
    return undefined;
  }

  const env = hostEnv(deps);

  if (MCP_PROJECT_ACTIONS.has(action)) {
    return runOnHost(deps, ["mcp", ...args], { cwd: deps.cwd, env });
  }

  return inEmptyDir(deps, ["mcp", ...args], { env });
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

const selfUpdate = async (deps: CliDeps) => {
  const pi = await requireJobPi(deps);
  const code = await deps.runner.spawnInteractive(pi.wrapper, ["update"], { cwd: deps.cwd });
  const followed = code === 0 ? await resolveJobPi(deps) : undefined;

  if (followed !== undefined) {
    writeLine(deps.stderr, `pi-sandbox: the sandbox follows pi ${followed.version} at the next launch`);
  }

  return code;
};

const sandboxPiVersion = async (deps: CliDeps) => {
  const { image } = (await loadEffectiveConfig({ env: deps.env, home: deps.home })).config;

  if (image.reference !== undefined && image.digest !== undefined) {
    return undefined;
  }

  writeLine(deps.stdout, await imagePiVersion(await resolveJobPi(deps)));

  return 0;
};

const routedJob = (deps: CliDeps, route: HostRoute) => {
  if (route.kind === "version") {
    return sandboxPiVersion(deps);
  }

  return route.kind === "cwd"
    ? runOnHost(deps, route.args, { cwd: deps.cwd, env: hostEnv(deps) })
    : inEmptyDir(deps, route.args, { env: hostEnv(deps) });
};

export const intercept = (
  argv: string[],
  deps: CliDeps,
): Promise<number | undefined> | number | undefined => {
  const route = hostRoute(argv);

  if (route !== undefined) {
    return routedJob(deps, route);
  }

  const [command, ...rest] = argv;

  if (command === "install" || command === "remove" || command === "uninstall") {
    const source = packageSource(rest);

    return source === undefined ? undefined : packageCommand(deps, argv, source);
  }

  if (command === "mcp") {
    return mcpCommand(deps, rest);
  }

  return command === "update" && isSelfUpdate(rest) ? selfUpdate(deps) : undefined;
};

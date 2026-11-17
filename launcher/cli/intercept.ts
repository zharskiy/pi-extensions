import { resolve } from "node:path";
import { loadEffectiveConfig } from "../config/index.ts";
import { isWithin, knownRepos, pathFromSetting, realOrResolved, repoRecordOf } from "../shared/index.ts";
import { assertSafeMounts, findGitRoot } from "../workspace/index.ts";
import { type CliDeps, pathsOf, writeLine, writeNotices } from "./deps.ts";
import { hostPiEnv, requireJobPi, resolveJobPi, runHostJob } from "./host-pi.ts";
import { type HostRoute, hostRoute, LOCAL_FLAGS } from "./host-routes.ts";
import { imagePiVersion } from "./versions.ts";

const runOnHost = async (
  deps: CliDeps,
  args: string[],
  where: "cwd" | "empty",
  env?: Record<string, string>,
) => {
  const pi = await requireJobPi(deps);

  return runHostJob(deps, [pi.wrapper, ...args], where, env);
};

const NPM_PREFIX = "npm:";

const NPM_SPEC = /^(@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(@[A-Za-z0-9.^~<>=|*+ -]+)?$/;

const GIT_PREFIX = /^git:(?!\/\/)/;

const GIT_PART = /^[A-Za-z0-9._-]+$/;

const GIT_HOST = /^[A-Za-z0-9.-]+$/;

const GIT_REF = /^[A-Za-z0-9._/-]+$/;

const SCP_SOURCE = /^git@([^:]+):(.+)$/;

const SHORT_SOURCE = /^([^/]+)\/(.+)$/;

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

const localPathOf = (text: string, home: string) => {
  try {
    return pathFromSetting(text, home);
  } catch {
    return text;
  }
};

const sandboxedRoots = async (stateDir: string) => {
  const records = await Promise.all((await knownRepos(stateDir)).map((hash) => repoRecordOf(stateDir, hash)));

  return Promise.all(
    records.flatMap((record) => (record === undefined ? [] : [realOrResolved(record.root)])),
  );
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
  const path = resolve(deps.cwd, localPathOf(text, deps.home));

  return { path, inRepository: await isSandboxable(deps, [path, await realOrResolved(path)]) };
};

const refuse = (deps: CliDeps, source: string, reason: string) => {
  writeNotices(deps, [`${source} ${reason}; not installed on the host`]);

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

  return runOnHost(deps, args, "empty", hostPiEnv(deps));
};

const MCP_HOST_ACTIONS = new Set(["add", "remove", "login", "logout"]);

const MCP_PROJECT_ACTIONS = new Set(["add", "remove"]);

const mcpCommand = (deps: CliDeps, args: string[]) => {
  const [action = ""] = args;

  if (!MCP_HOST_ACTIONS.has(action)) {
    return undefined;
  }

  const env = hostPiEnv(deps);

  if (MCP_PROJECT_ACTIONS.has(action)) {
    return runOnHost(deps, ["mcp", ...args], "cwd", env);
  }

  return runOnHost(deps, ["mcp", ...args], "empty", env);
};

const packageSource = (args: string[]) => {
  if (args.some((arg) => LOCAL_FLAGS.includes(arg))) {
    return undefined;
  }

  const sources = args.filter((arg) => !arg.startsWith("-"));

  return sources.length === 1 ? sources[0] : undefined;
};

const SELF_TARGETS = ["pi", "self", "--self"];

const SELF_SOURCES = ["pi", "self"];

const isSelfUpdate = (args: string[]) =>
  args.length === 0 || (args.length === 1 && SELF_TARGETS.includes(args[0] ?? ""));

const isExtensionValue = (args: string[], index: number) =>
  args[index - 1] === "--extension" && !(args[index] ?? "").startsWith("-");

const updatesSelf = (args: string[]) => {
  const flags = new Set(args.filter((arg) => arg.startsWith("-")));
  const [source] = args.filter((arg, index) => !arg.startsWith("-") && !isExtensionValue(args, index));

  if (flags.has("--models") || flags.has("--extension")) {
    return false;
  }

  if (source !== undefined) {
    return SELF_SOURCES.includes(source);
  }

  return flags.has("--self") || !flags.has("--extensions");
};

const noticeFollowedPi = async (deps: CliDeps) => {
  const followed = await resolveJobPi(deps);

  if (followed !== undefined) {
    writeNotices(deps, [`the sandbox follows pi ${followed.version} at the next launch`]);
  }
};

const selfUpdate = async (deps: CliDeps) => {
  const code = await runOnHost(deps, ["update"], "empty", hostPiEnv(deps));

  if (code === 0) {
    await noticeFollowedPi(deps);
  }

  return code;
};

const PATH_LIKE = /^(\.|~|file:\/\/|[^:]*\/)/;

const updateSource = (args: string[]) =>
  args.find(
    (arg, index) =>
      !arg.startsWith("-") &&
      !isExtensionValue(args, index) &&
      !SELF_SOURCES.includes(arg) &&
      PATH_LIKE.test(arg),
  );

const updateArgv = async (deps: CliDeps, argv: string[], args: string[]) => {
  const source = updateSource(args);
  const classified = source === undefined ? undefined : classifySource(source);

  if (source === undefined || classified?.kind !== "local") {
    return argv;
  }

  const { path } = await resolvedLocal(deps, classified.text);

  return argv.map((arg) => (arg === source ? path : arg));
};

const hostUpdate = async (deps: CliDeps, argv: string[], args: string[]) => {
  const code = await runOnHost(deps, await updateArgv(deps, argv, args), "empty", hostPiEnv(deps));

  if (code === 0 && updatesSelf(args)) {
    await noticeFollowedPi(deps);
  }

  return code;
};

const updateCommand = (deps: CliDeps, argv: string[], args: string[]) =>
  isSelfUpdate(args) ? selfUpdate(deps) : hostUpdate(deps, argv, args);

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

  return runOnHost(deps, route.args, route.kind === "cwd" ? "cwd" : "empty", hostPiEnv(deps));
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

  return command === "update" ? updateCommand(deps, argv, rest) : undefined;
};

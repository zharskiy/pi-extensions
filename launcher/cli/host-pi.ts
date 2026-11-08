import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { type BundledPi, type HostPi, locateManagedPi, locatePiPackage } from "../hostpi/index.ts";
import { expandHome, isWithin, launcherRoot, realOrResolved } from "../shared/index.ts";
import { findGitRoot } from "../workspace/index.ts";
import { type CliDeps, hostAgentDirOf } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";

const WRAPPER_LIMIT = 4096;

const WRAPPER_MARKER = "launcher/bin/pi-sandbox";

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

const isWrapper = async (path: string) => {
  const info = await stat(path);

  if (!info.isFile() || info.size > WRAPPER_LIMIT) {
    return false;
  }

  return (await readFile(path, "utf8")).includes(WRAPPER_MARKER);
};

const isLauncher = async (real: string, ownBinDir: string) =>
  isWithin(real, ownBinDir) || (await isWrapper(real));

const isOutside = (paths: string[], roots: string[]) =>
  !paths.some((path) => roots.some((root) => isWithin(path, root)));

const isHostPiCandidate = async (path: string, ownBinDir: string, roots: string[]) => {
  const real = await realpath(path).catch(() => undefined);

  if (real === undefined || !isOutside([path, real], roots) || !(await isExecutable(path))) {
    return false;
  }

  return !(await isLauncher(real, ownBinDir).catch(() => true));
};

const realRoots = async (roots: string[]) => [
  ...roots,
  ...(await Promise.all(roots.map((root) => realOrResolved(root)))),
];

const pathCandidates = async (deps: CliDeps, roots: string[]) => {
  const ownBinDir = await realOrResolved(join(launcherRoot(), "bin"));
  const excluded = await realRoots(roots);
  const candidates = (deps.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, "pi"));
  const verdicts = await Promise.all(candidates.map((path) => isHostPiCandidate(path, ownBinDir, excluded)));

  return candidates.filter((_, index) => verdicts[index]);
};

export interface ShellPi {
  command: string[];
  source: HostPi["source"];
  version?: string;
  wrapper?: string;
}

const bundledSource = (bundled: BundledPi | undefined): HostPi | undefined =>
  bundled === undefined ? undefined : { ...bundled, source: "bundled" };

export const sandboxRoots = (deps: CliDeps, context: LaunchContext) => [
  context.workspace.repoRoot,
  ...(context.workspace.gitCommonDir === undefined ? [] : [context.workspace.gitCommonDir]),
  ...context.effective.config.mounts.extraReadOnly.map((path) =>
    resolve(context.workspace.repoRoot, expandHome(path, deps.home)),
  ),
];

export const nearbyRoots = async (deps: CliDeps) => {
  const repoRoot = await findGitRoot(await realOrResolved(deps.cwd));

  return repoRoot === undefined ? [deps.cwd] : [deps.cwd, repoRoot];
};

export const resolveJobPi = async (deps: CliDeps): Promise<HostPi | undefined> =>
  (await locateManagedPi(hostAgentDirOf(deps))) ?? bundledSource(await deps.bundledPi());

export const resolveShellPi = async (deps: CliDeps, roots: string[]): Promise<ShellPi | undefined> => {
  const managed = await locateManagedPi(hostAgentDirOf(deps));

  if (managed !== undefined) {
    return managed;
  }

  const [onPath] = await pathCandidates(deps, roots);

  if (onPath === undefined) {
    return bundledSource(await deps.bundledPi());
  }

  return (await locatePiPackage(onPath)) ?? { command: [onPath], source: "path" };
};

export const interactiveCommand = (pi: ShellPi) => (pi.wrapper === undefined ? pi.command : [pi.wrapper]);

export const hostPiCommand = async (deps: CliDeps, roots: string[]) => {
  const pi = await resolveShellPi(deps, roots);

  return pi === undefined ? undefined : interactiveCommand(pi);
};

export const hostPiPlace = (pi: ShellPi) => {
  if (pi.source === "managed") {
    return `managed install ${pi.wrapper ?? ""}`;
  }

  return pi.source === "path" ? `at ${pi.command.at(-1) ?? ""}` : "next to the launcher";
};

export const hostPiText = (pi: ShellPi) =>
  `pi${pi.version === undefined ? "" : ` ${pi.version}`}${pi.source === "managed" ? "," : ""} ${hostPiPlace(pi)}`;

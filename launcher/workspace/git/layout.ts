import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isWithin, LauncherError, lstatOrUndefined, readRegularFile } from "../../shared/index.ts";

export interface GitLayout {
  gitDir: string;
  gitCommonDir: string;
}

const OWN_COMMONDIR = /^\.\n?$/;

const GIT_FILE_PREFIX = "gitdir: ";

const HINT =
  "check the file and remove it if you did not create it; the launcher refuses this repository until then";

export const gitRefusal = (path: string, problem: string) =>
  new LauncherError(`git: ${path} ${problem}`, HINT);

const isOwnCommondir = (text: string | undefined) => text === undefined || OWN_COMMONDIR.test(text);

export const pointerPath = (base: string, text: string) => resolve(base, text.trimEnd());

export const gitFileTarget = (base: string, text: string) => {
  const [line = ""] = text.split("\n");

  return line.startsWith(GIT_FILE_PREFIX) ? pointerPath(base, line.slice(GIT_FILE_PREFIX.length)) : undefined;
};

export const lstatKind = async (path: string, kind: "file" | "dir") => {
  const info = await lstatOrUndefined(path);

  if (info?.isSymbolicLink() === true) {
    throw gitRefusal(path, "is a symbolic link");
  }

  if (info === undefined) {
    return "missing";
  }

  return (kind === "dir" ? info.isDirectory() : info.isFile()) ? "match" : "other";
};

export const readGitPointer = async (path: string) => {
  const kind = await lstatKind(path, "file");

  if (kind === "missing") {
    return undefined;
  }

  if (kind === "other") {
    throw gitRefusal(path, "is not a regular file");
  }

  const file = await readRegularFile(path).catch(() => undefined);

  if (file === undefined) {
    throw gitRefusal(path, "could not be read");
  }

  return file.data.toString("utf8");
};

const requiredPointer = async (path: string) => {
  const text = await readGitPointer(path);

  if (text === undefined) {
    throw gitRefusal(path, "is missing");
  }

  return text;
};

const realOrRefuse = (path: string, owner: string) =>
  realpath(path).catch(() => {
    throw gitRefusal(owner, `points at ${path}, which does not exist`);
  });

export const assertOwnCommondir = async (gitDir: string) => {
  const path = join(gitDir, "commondir");

  if (!isOwnCommondir(await readGitPointer(path))) {
    throw gitRefusal(path, "was not written by git");
  }
};

const ownGitDir = async (gitDir: string): Promise<GitLayout> => {
  await assertOwnCommondir(gitDir);

  return { gitDir, gitCommonDir: gitDir };
};

const linkedGitDir = async (repoRoot: string, dotGit: string) => {
  const target = gitFileTarget(repoRoot, await requiredPointer(dotGit));

  if (target === undefined) {
    throw gitRefusal(dotGit, "is not a gitdir file");
  }

  if ((await lstatKind(target, "dir")) !== "match") {
    throw gitRefusal(dotGit, `points at ${target}, which is not a directory`);
  }

  const real = await realpath(target);

  if (isWithin(target, repoRoot) && real !== target) {
    throw gitRefusal(dotGit, `points at ${target} through a symbolic link`);
  }

  if (basename(real) === ".git") {
    throw gitRefusal(dotGit, `points at ${real}, the git dir of another checkout`);
  }

  return real;
};

const worktreeLayout = async (repoRoot: string, gitDir: string, pointer: string): Promise<GitLayout> => {
  const commondir = join(gitDir, "commondir");
  const gitCommonDir = await realOrRefuse(pointerPath(gitDir, pointer), commondir);

  if (basename(dirname(gitDir)) !== "worktrees" || dirname(dirname(gitDir)) !== gitCommonDir) {
    throw gitRefusal(commondir, `points at ${gitCommonDir}, which does not hold ${gitDir}`);
  }

  const back = join(gitDir, "gitdir");
  const linked = await realOrRefuse(pointerPath(gitDir, await requiredPointer(back)), back);
  const dotGit = join(repoRoot, ".git");

  if (linked !== dotGit) {
    throw gitRefusal(back, `points at ${linked}, not ${dotGit}`);
  }

  return { gitDir, gitCommonDir };
};

export const gitLayoutAt = async (repoRoot: string): Promise<GitLayout> => {
  const dotGit = join(repoRoot, ".git");
  const kind = await lstatKind(dotGit, "dir");

  if (kind === "missing") {
    throw gitRefusal(dotGit, "is missing");
  }

  if (kind === "match") {
    return ownGitDir(dotGit);
  }

  const gitDir = await linkedGitDir(repoRoot, dotGit);
  const text = await readGitPointer(join(gitDir, "commondir"));

  return text === undefined || isOwnCommondir(text)
    ? ownGitDir(gitDir)
    : worktreeLayout(repoRoot, gitDir, text);
};

export const findGitRoot = async (dir: string): Promise<string | undefined> => {
  if ((await lstatOrUndefined(join(dir, ".git"))) !== undefined) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : findGitRoot(parent);
};

const isStructuralDir = async (dir: string) => (await lstatKind(dir, "dir")) === "match";

const realChildDirs = async (dir: string) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const linked = entries.find((entry) => entry.isSymbolicLink());

  if (linked !== undefined) {
    throw gitRefusal(join(dir, linked.name), "is a symbolic link");
  }

  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
};

const isGitDir = async (dir: string) => (await lstatOrUndefined(join(dir, "HEAD")))?.isFile() === true;

const moduleGitDirsUnder = async (dir: string): Promise<string[]> => {
  if (!(await isStructuralDir(dir))) {
    return [];
  }

  const children = await realChildDirs(dir);
  const found = await Promise.all(
    children.map(async (child) =>
      (await isGitDir(child))
        ? [child, ...(await moduleGitDirsUnder(join(child, "modules")))]
        : moduleGitDirsUnder(child),
    ),
  );

  return found.flat();
};

export const findWorktreeGitDirs = async (gitCommonDir: string) => {
  const dir = join(gitCommonDir, "worktrees");

  return (await isStructuralDir(dir)) ? realChildDirs(dir) : [];
};

export const findModuleGitDirs = async (gitCommonDir: string) => {
  const owners = [gitCommonDir, ...(await findWorktreeGitDirs(gitCommonDir))];
  const found = await Promise.all(owners.map((dir) => moduleGitDirsUnder(join(dir, "modules"))));

  return found.flat();
};

const readQuietly = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => undefined,
  );

export const lexicalGitLayout = async (repoRoot: string): Promise<GitLayout> => {
  const dotGit = join(repoRoot, ".git");
  const text = await readQuietly(dotGit);
  const gitDir = (text === undefined ? undefined : gitFileTarget(repoRoot, text)) ?? dotGit;
  const pointer = await readQuietly(join(gitDir, "commondir"));
  return {
    gitDir,
    gitCommonDir:
      pointer === undefined || pointer === "" || isOwnCommondir(pointer)
        ? gitDir
        : pointerPath(gitDir, pointer),
  };
};

export const isGitName = (name: string) => name.toLowerCase() === ".git";

const SHAPE_NAMES = ["head", "commondir", "objects", "refs"];

export const hasGitDirShape = (names: string[]) => {
  const present = SHAPE_NAMES.filter((name) => names.some((entry) => entry.toLowerCase() === name));

  return (
    present.includes("head") &&
    (present.includes("commondir") || (present.includes("objects") && present.includes("refs")))
  );
};

const isGitDirAt = async (dir: string) => hasGitDirShape(await readdir(dir).catch(() => []));

export const gitDirHolding = async (dir: string): Promise<string | undefined> => {
  if (await isGitDirAt(dir)) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : gitDirHolding(parent);
};

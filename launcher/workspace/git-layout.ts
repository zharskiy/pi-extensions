import type { Stats } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isWithin, LauncherError, lstatOrUndefined, readRegularFile } from "../shared/index.ts";

export interface GitLayout {
  gitDir: string;
  gitCommonDir: string;
}

const PIN = /^\.\n?$/;

const GIT_FILE_PREFIX = "gitdir: ";

const HINT =
  "check the file and remove it if you did not create it; the launcher refuses this repository until then";

export const gitRefusal = (path: string, problem: string) =>
  new LauncherError(`git: ${path} ${problem}`, HINT);

export const isPinText = (text: string) => PIN.test(text);

export const pointerPath = (base: string, text: string) => resolve(base, text.trimEnd());

export const readGitPointer = async (path: string, info: Stats) => {
  if (info.isSymbolicLink()) {
    throw gitRefusal(path, "is a symbolic link");
  }

  if (!info.isFile()) {
    throw gitRefusal(path, "is not a regular file");
  }

  const file = await readRegularFile(path).catch(() => undefined);

  if (file === undefined) {
    throw gitRefusal(path, "could not be read");
  }

  return file.data.toString("utf8");
};

const realOrRefuse = (path: string, owner: string) =>
  realpath(path).catch(() => {
    throw gitRefusal(owner, `points at ${path}, which does not exist`);
  });

export const pinStateOf = async (gitDir: string) => {
  const path = join(gitDir, "commondir");
  const info = await lstatOrUndefined(path);

  if (info === undefined) {
    return "absent";
  }

  if (!isPinText(await readGitPointer(path, info))) {
    throw gitRefusal(path, "was not written by git or the launcher");
  }

  return "pinned";
};

const ownGitDir = async (gitDir: string): Promise<GitLayout> => {
  await pinStateOf(gitDir);

  return { gitDir, gitCommonDir: gitDir };
};

const linkedGitDir = async (repoRoot: string, dotGit: string, info: Stats) => {
  const [line = ""] = (await readGitPointer(dotGit, info)).split("\n");

  if (!line.startsWith(GIT_FILE_PREFIX)) {
    throw gitRefusal(dotGit, "is not a gitdir file");
  }

  const target = pointerPath(repoRoot, line.slice(GIT_FILE_PREFIX.length));
  const entry = await lstatOrUndefined(target);

  if (entry?.isSymbolicLink() === true) {
    throw gitRefusal(target, "is a symbolic link");
  }

  if (entry === undefined || !entry.isDirectory()) {
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
  const info = await lstatOrUndefined(back);

  if (info === undefined) {
    throw gitRefusal(back, "is missing");
  }

  const linked = await realOrRefuse(pointerPath(gitDir, await readGitPointer(back, info)), back);
  const dotGit = join(repoRoot, ".git");

  if (linked !== dotGit) {
    throw gitRefusal(back, `points at ${linked}, not ${dotGit}`);
  }

  return { gitDir, gitCommonDir };
};

export const gitLayoutAt = async (repoRoot: string): Promise<GitLayout> => {
  const dotGit = join(repoRoot, ".git");
  const info = await lstatOrUndefined(dotGit);

  if (info === undefined) {
    throw gitRefusal(dotGit, "is missing");
  }

  if (info.isSymbolicLink()) {
    throw gitRefusal(dotGit, "is a symbolic link");
  }

  if (info.isDirectory()) {
    return ownGitDir(dotGit);
  }

  const gitDir = await linkedGitDir(repoRoot, dotGit, info);
  const commondir = join(gitDir, "commondir");
  const pointer = await lstatOrUndefined(commondir);

  if (pointer === undefined) {
    return { gitDir, gitCommonDir: gitDir };
  }

  const text = await readGitPointer(commondir, pointer);

  return isPinText(text) ? { gitDir, gitCommonDir: gitDir } : worktreeLayout(repoRoot, gitDir, text);
};

export const findGitRoot = async (dir: string): Promise<string | undefined> => {
  if ((await lstatOrUndefined(join(dir, ".git"))) !== undefined) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : findGitRoot(parent);
};

const isStructuralDir = async (dir: string) => {
  const info = await lstatOrUndefined(dir);

  if (info?.isSymbolicLink() === true) {
    throw gitRefusal(dir, "is a symbolic link");
  }

  return info?.isDirectory() === true;
};

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

export const findModuleGitDirs = (gitCommonDir: string) => moduleGitDirsUnder(join(gitCommonDir, "modules"));

export const findWorktreeGitDirs = async (gitCommonDir: string) => {
  const dir = join(gitCommonDir, "worktrees");

  return (await isStructuralDir(dir)) ? realChildDirs(dir) : [];
};

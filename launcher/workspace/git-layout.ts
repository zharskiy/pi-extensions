import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isWithin, LauncherError, lstatOrUndefined, readRegularFile, sameEntry } from "../shared/index.ts";

export interface GitLayout {
  gitDir: string;
  gitCommonDir: string;
}

const PIN = /^\.\n?$/;

export const PIN_TEXT = ".\n";

const GIT_FILE_PREFIX = "gitdir: ";

const HINT =
  "check the file and remove it if you did not create it; the launcher refuses this repository until then";

export const gitRefusal = (path: string, problem: string) =>
  new LauncherError(`git: ${path} ${problem}`, HINT);

export const isPinText = (text: string) => PIN.test(text);

export const pointerPath = (base: string, text: string) => resolve(base, text.trimEnd());

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

const fillEmptyPin = async (path: string) => {
  const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW).catch(() => undefined);

  if (handle === undefined) {
    throw gitRefusal(path, "is empty and could not be pinned");
  }

  try {
    const [opened, current] = await Promise.all([handle.stat(), lstatOrUndefined(path)]);

    if (
      !opened.isFile() ||
      opened.size !== 0 ||
      opened.nlink !== 1 ||
      current === undefined ||
      !sameEntry(opened, current)
    ) {
      throw gitRefusal(path, "changed while it was pinned");
    }

    await handle.write(PIN_TEXT, 0);
  } finally {
    await handle.close();
  }
};

export const pinStateOf = async (gitDir: string) => {
  const path = join(gitDir, "commondir");
  const text = await readGitPointer(path);

  if (text === undefined) {
    return "absent";
  }

  if (text === "") {
    await fillEmptyPin(path);

    return "pinned";
  }

  if (!isPinText(text)) {
    throw gitRefusal(path, "was not written by git or the launcher");
  }

  return "pinned";
};

const ownGitDir = async (gitDir: string): Promise<GitLayout> => {
  await pinStateOf(gitDir);

  return { gitDir, gitCommonDir: gitDir };
};

const linkedGitDir = async (repoRoot: string, dotGit: string) => {
  const [line = ""] = (await requiredPointer(dotGit)).split("\n");

  if (!line.startsWith(GIT_FILE_PREFIX)) {
    throw gitRefusal(dotGit, "is not a gitdir file");
  }

  const target = pointerPath(repoRoot, line.slice(GIT_FILE_PREFIX.length));
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

  return text === undefined || text === "" || isPinText(text)
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

export const findModuleGitDirs = (gitCommonDir: string) => moduleGitDirsUnder(join(gitCommonDir, "modules"));

export const findWorktreeGitDirs = async (gitCommonDir: string) => {
  const dir = join(gitCommonDir, "worktrees");

  return (await isStructuralDir(dir)) ? realChildDirs(dir) : [];
};

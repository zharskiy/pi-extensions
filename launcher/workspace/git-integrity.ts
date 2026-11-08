import { randomBytes } from "node:crypto";
import { link, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LauncherError,
  lstatOrUndefined,
  readRegularFile,
  sameEntry,
  sha256Hex,
  stateLayout,
  withFileLock,
} from "../shared/index.ts";
import {
  findModuleGitDirs,
  findWorktreeGitDirs,
  gitLayoutAt,
  gitRefusal,
  isPinText,
  PIN_TEXT,
  pinStateOf,
  pointerPath,
  readGitPointer,
} from "./git-layout.ts";
import { gitDirOf, gitRepos, type Workspace } from "./types.ts";

const PIN_MODE = 0o644;

const PIN_LOCK_TIMEOUT_MS = 120_000;

const ALTERNATES = [
  ["objects", "info", "alternates"],
  ["objects", "info", "http-alternates"],
];

const pinLockTimeout = { timeoutMs: PIN_LOCK_TIMEOUT_MS };

export const withGitPinLock = <T>(stateDir: string, workspace: Workspace, action: () => Promise<T>) => {
  const layout = stateLayout(stateDir);
  const gitCommonDirs = gitRepos(workspace)
    .map((repo) => repo.gitCommonDir)
    .filter((dir) => dir !== undefined);

  return [...new Set(gitCommonDirs)]
    .sort()
    .reduceRight<() => Promise<T>>(
      (inner, gitCommonDir) => () =>
        withFileLock(layout.gitPinLock(sha256Hex(gitCommonDir)), inner, pinLockTimeout),
      action,
    )();
};

const assertWorktreePointers = async (worktreeDir: string, gitCommonDir: string) => {
  await readGitPointer(join(worktreeDir, "gitdir"));

  const commondir = join(worktreeDir, "commondir");
  const text = await readGitPointer(commondir);

  if (text === undefined) {
    return;
  }

  const target = await realpath(pointerPath(worktreeDir, text)).catch(() => "a missing directory");

  if (target !== gitCommonDir) {
    throw gitRefusal(commondir, `points at ${target}, not ${gitCommonDir}`);
  }
};

export const assertGitIntegrity = async (workspace: Workspace): Promise<string[]> => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const layout = await gitLayoutAt(workspace.repoRoot);
  const gitDir = gitDirOf(workspace, gitCommonDir);

  if (layout.gitDir !== gitDir || layout.gitCommonDir !== gitCommonDir) {
    throw gitRefusal(join(workspace.repoRoot, ".git"), `now leads to ${layout.gitDir}, not ${gitDir}`);
  }

  const worktrees = await findWorktreeGitDirs(gitCommonDir);

  await Promise.all(worktrees.map((dir) => assertWorktreePointers(dir, gitCommonDir)));

  const modules = await findModuleGitDirs(gitCommonDir);

  await Promise.all([gitCommonDir, ...modules].map(pinStateOf));

  return modules;
};

const writeGitPin = async (gitDir: string) => {
  if ((await pinStateOf(gitDir)) === "pinned") {
    return;
  }

  const path = join(gitDir, "commondir");
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  await writeFile(temporary, PIN_TEXT, { flag: "wx", mode: PIN_MODE });

  const linked = await link(temporary, path).then(
    () => true,
    () => false,
  );

  await rm(temporary, { force: true });

  const written =
    linked ||
    (await writeFile(path, PIN_TEXT, { flag: "wx", mode: PIN_MODE }).then(
      () => true,
      () => false,
    ));

  if (!written && (await pinStateOf(gitDir)) === "absent") {
    throw new LauncherError(`git: could not write ${path}`);
  }
};

export const pinGitDirs = async (workspace: Workspace, modules: string[]) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir !== undefined) {
    await Promise.all([gitCommonDir, ...modules].map(writeGitPin));
  }
};

const pinTextOf = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => undefined,
  );

const removePin = async (gitDir: string): Promise<string[]> => {
  const path = join(gitDir, "commondir");
  const info = await lstatOrUndefined(path);

  if (info === undefined) {
    return [];
  }

  const text = info.isFile() ? await pinTextOf(path) : undefined;
  const again = await lstatOrUndefined(path);
  const removed =
    again !== undefined &&
    sameEntry(again, info) &&
    (await unlink(path).then(
      () => true,
      () => false,
    ));

  if (!removed) {
    return [`git: ${path} could not be removed; remove it before running git in this repository`];
  }

  return text !== undefined && isPinText(text)
    ? []
    : [`git: ${path} was changed inside the sandbox; the launcher removed it`];
};

export const unpinGitDirs = async (workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const modules = await findModuleGitDirs(gitCommonDir).catch(() => []);
  const notices = await Promise.all([gitCommonDir, ...modules].map(removePin));

  return notices.flat();
};

export const gitAlternatesNotices = async (workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const found = await Promise.all(
    ALTERNATES.map(async (parts) => {
      const path = join(gitCommonDir, ...parts);

      return (await lstatOrUndefined(path)) === undefined
        ? []
        : [
            `git: ${path} is present, so host git also reads objects from the places it lists; check it if you did not set it up`,
          ];
    }),
  );

  return found.flat();
};

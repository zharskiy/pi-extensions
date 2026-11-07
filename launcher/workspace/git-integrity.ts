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
  pinStateOf,
  pointerPath,
  readGitPointer,
} from "./git-layout.ts";
import type { Workspace } from "./types.ts";

const PIN_TEXT = ".\n";

const PIN_MODE = 0o644;

const PIN_LOCK_TIMEOUT_MS = 120_000;

const ALTERNATES = [
  ["objects", "info", "alternates"],
  ["objects", "info", "http-alternates"],
];

export const gitDirOf = (workspace: Workspace) => workspace.gitDir ?? workspace.gitCommonDir;

export const withGitPinLock = <T>(stateDir: string, workspace: Workspace, action: () => Promise<T>) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return action();
  }

  return withFileLock(stateLayout(stateDir).gitPinLock(sha256Hex(gitCommonDir)), action, {
    timeoutMs: PIN_LOCK_TIMEOUT_MS,
  });
};

const gitDirsToPin = async (workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  return gitCommonDir === undefined ? [] : [gitCommonDir, ...(await findModuleGitDirs(gitCommonDir))];
};

const assertWorktreePointers = async (worktreeDir: string, gitCommonDir: string) => {
  const back = join(worktreeDir, "gitdir");
  const backInfo = await lstatOrUndefined(back);

  if (backInfo !== undefined) {
    await readGitPointer(back, backInfo);
  }

  const commondir = join(worktreeDir, "commondir");
  const info = await lstatOrUndefined(commondir);

  if (info === undefined) {
    return;
  }

  const target = await realpath(pointerPath(worktreeDir, await readGitPointer(commondir, info))).catch(
    () => "a missing directory",
  );

  if (target !== gitCommonDir) {
    throw gitRefusal(commondir, `points at ${target}, not ${gitCommonDir}`);
  }
};

export const assertGitIntegrity = async (workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return;
  }

  const layout = await gitLayoutAt(workspace.repoRoot);
  const gitDir = gitDirOf(workspace);

  if (layout.gitDir !== gitDir || layout.gitCommonDir !== gitCommonDir) {
    throw gitRefusal(join(workspace.repoRoot, ".git"), `now leads to ${layout.gitDir}, not ${gitDir}`);
  }

  const worktrees = await findWorktreeGitDirs(gitCommonDir);

  await Promise.all(worktrees.map((dir) => assertWorktreePointers(dir, gitCommonDir)));

  const pinned = await gitDirsToPin(workspace);

  await Promise.all(pinned.map(pinStateOf));
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

export const pinGitDirs = async (workspace: Workspace) => {
  const dirs = await gitDirsToPin(workspace);

  await Promise.all(dirs.map(writeGitPin));
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

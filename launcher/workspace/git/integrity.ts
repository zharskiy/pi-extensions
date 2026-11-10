import { randomBytes } from "node:crypto";
import { link, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LauncherError,
  lstatOrUndefined,
  type PinRecord,
  readRegularFile,
  sameEntry,
  sha256Hex,
  stateLayout,
  withFileLock,
} from "../../shared/index.ts";
import { gitRepos, type Workspace } from "../types.ts";
import {
  fillEmptyPin,
  findModuleGitDirs,
  findWorktreeGitDirs,
  gitLayoutAt,
  gitRefusal,
  isPinText,
  PIN_TEXT,
  pinStateOf,
  pointerPath,
  readGitPointer,
} from "./layout.ts";

const PIN_MODE = 0o644;

const PIN_LOCK_TIMEOUT_MS = 120_000;

const ALTERNATES = [
  ["objects", "info", "alternates"],
  ["objects", "info", "http-alternates"],
];

const pinLockTimeout = { timeoutMs: PIN_LOCK_TIMEOUT_MS };

const withGitDirPinLock = <T>(stateDir: string, gitCommonDir: string, action: () => Promise<T>) =>
  withFileLock(stateLayout(stateDir).gitPinLock(sha256Hex(gitCommonDir)), action, pinLockTimeout);

export const withGitPinLock = <T>(stateDir: string, workspace: Workspace, action: () => Promise<T>) => {
  const gitCommonDirs = gitRepos(workspace)
    .map((repo) => repo.gitCommonDir)
    .filter((dir) => dir !== undefined);

  return [...new Set(gitCommonDirs)]
    .sort()
    .reduceRight<() => Promise<T>>(
      (inner, gitCommonDir) => () => withGitDirPinLock(stateDir, gitCommonDir, inner),
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
  const gitDir = workspace.gitDir ?? gitCommonDir;

  if (layout.gitDir !== gitDir || layout.gitCommonDir !== gitCommonDir) {
    throw gitRefusal(join(workspace.repoRoot, ".git"), `now leads to ${layout.gitDir}, not ${gitDir}`);
  }

  const worktrees = await findWorktreeGitDirs(gitCommonDir);

  await Promise.all(worktrees.map((dir) => assertWorktreePointers(dir, gitCommonDir)));

  const modules = await findModuleGitDirs(gitCommonDir);

  await Promise.all([gitCommonDir, ...modules].map(pinStateOf));

  return modules;
};

type PinWritten = (path: string) => Promise<void>;

const writeGitPin = async (gitDir: string, onPin: PinWritten): Promise<void> => {
  const path = join(gitDir, "commondir");
  const state = await pinStateOf(gitDir);

  if (state !== "absent") {
    if (state === "empty") {
      await fillEmptyPin(path);
    }

    await onPin(path);

    return;
  }

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

  await onPin(path);
};

export const pinGitDirs = async (workspace: Workspace, modules: string[], onPin: PinWritten) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return;
  }

  const outcomes = await Promise.allSettled([gitCommonDir, ...modules].map((dir) => writeGitPin(dir, onPin)));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }
};

const pinTextOf = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => undefined,
  );

const removePin = async (path: string): Promise<string[]> => {
  const info = await lstatOrUndefined(path);

  if (info === undefined) {
    return [];
  }

  const text = info.isFile() ? await pinTextOf(path) : undefined;

  if (text === undefined || !isPinText(text)) {
    return [`git: ${path} no longer holds the launcher's pin, so it was left in place`];
  }

  const again = await lstatOrUndefined(path);
  const removed =
    again !== undefined &&
    sameEntry(again, info) &&
    (await unlink(path).then(
      () => true,
      () => false,
    ));

  return removed
    ? []
    : [`git: ${path} could not be removed; remove it before running git in this repository`];
};

type PinInUse = (gitCommonDir: string) => Promise<boolean>;

const releasePin = (stateDir: string, pin: PinRecord, inUse: PinInUse) =>
  withGitDirPinLock(stateDir, pin.gitCommonDir, async () =>
    (await inUse(pin.gitCommonDir))
      ? { kept: [pin], notices: [] }
      : { kept: [], notices: await removePin(pin.path) },
  );

export const unpinRecorded = async (stateDir: string, pins: PinRecord[], inUse: PinInUse) => {
  const outcomes = await Promise.all(pins.map((pin) => releasePin(stateDir, pin, inUse)));

  return {
    kept: outcomes.flatMap((outcome) => outcome.kept),
    notices: outcomes.flatMap((outcome) => outcome.notices),
  };
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

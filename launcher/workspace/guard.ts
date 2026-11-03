import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isWithin, LauncherError, launcherPaths } from "../shared/index.ts";
import type { Workspace } from "./types.ts";

interface GuardContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const realOrResolved = (path: string) => {
  const absolute = resolve(path);

  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
};

const DEFAULT_CONFIG_DIR = [".config", "pi-sandbox"];

const protectedConfig = (context: GuardContext, userConfigFile: string) => {
  const defaultDir = resolve(context.home, ...DEFAULT_CONFIG_DIR);

  return resolve(dirname(userConfigFile)) === defaultDir ? defaultDir : userConfigFile;
};

const launcherDirs = (context: GuardContext) => {
  const paths = launcherPaths(context);

  return [join(context.home, ".pi"), paths.stateDir, protectedConfig(context, paths.userConfigFile)].map(
    realOrResolved,
  );
};

const HINT = "run pi inside a project directory";

const assertOutsideLauncherDirs = (mounted: string[], context: GuardContext) => {
  const dirs = launcherDirs(context);
  const inside = mounted.find((path) => dirs.some((dir) => isWithin(path, dir)));

  if (inside === undefined) {
    return;
  }

  const container = dirs.find((dir) => isWithin(inside, dir));

  throw new LauncherError(`${inside} is inside ${container}, refusing to mount it into the sandbox`, HINT);
};

export const assertSafeWorkspace = (workspace: Workspace, context: GuardContext) => {
  const dirs = ["/", context.home].map(realOrResolved).concat(launcherDirs(context));
  const mounted = [workspace.repoRoot, workspace.gitCommonDir].filter((path) => path !== undefined);
  const unsafe = mounted.find((path) => dirs.some((dir) => isWithin(dir, path)));

  if (unsafe === undefined) {
    assertOutsideLauncherDirs(mounted, context);

    return;
  }

  const covered = dirs.find((dir) => isWithin(dir, unsafe));

  throw new LauncherError(`${unsafe} would mount ${covered} into the sandbox, refusing`, HINT);
};

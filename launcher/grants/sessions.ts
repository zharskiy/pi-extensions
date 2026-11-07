import { LauncherError } from "../shared/index.ts";
import type { EndSessionInput, SessionEntry } from "./types.ts";

export const newLaunchId = (): string => {
  throw new LauncherError("newLaunchId is not implemented");
};

export const registerSession = async (_stateDir: string, _entry: SessionEntry): Promise<number> => {
  throw new LauncherError("registerSession is not implemented");
};

export const endSession = async (_stateDir: string, _input: EndSessionInput): Promise<number> => {
  throw new LauncherError("endSession is not implemented");
};

export const liveSessions = async (
  _stateDir: string,
  _repoHash?: string,
  _isAlive?: (pid: number) => boolean,
): Promise<SessionEntry[]> => {
  throw new LauncherError("liveSessions is not implemented");
};

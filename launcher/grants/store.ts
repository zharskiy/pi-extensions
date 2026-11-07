import { LauncherError } from "../shared/index.ts";
import type { ActiveGrantContext, Grant, GrantLimits, GrantMatch, GrantRequest } from "./types.ts";

export const SESSION_GRANT_CAP_HOURS = 12;

export const readGrants = async (_stateDir: string): Promise<Grant[]> => {
  throw new LauncherError("readGrants is not implemented");
};

export const addGrant = async (
  _stateDir: string,
  _request: GrantRequest,
  _limits: GrantLimits,
  _now: number,
): Promise<Grant> => {
  throw new LauncherError("addGrant is not implemented");
};

export const revokeGrants = async (_stateDir: string, _match: GrantMatch): Promise<number> => {
  throw new LauncherError("revokeGrants is not implemented");
};

export const activeGrants = (_grants: Grant[], _context: ActiveGrantContext): Grant[] => {
  throw new LauncherError("activeGrants is not implemented");
};

export const pruneGrants = async (
  _stateDir: string,
  _context: { now: number; liveLaunches: ReadonlySet<string> },
): Promise<number> => {
  throw new LauncherError("pruneGrants is not implemented");
};

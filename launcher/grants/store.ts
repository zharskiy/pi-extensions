import { isJsonObject, readJsonFile, stateLayout, withFileLock, writeJsonFile } from "../shared/index.ts";
import type { Grant, GrantMatch, GrantRequest } from "./types.ts";

const PRIVATE_MODE = 0o600;

const isGrant = (value: unknown): value is Grant =>
  isJsonObject(value) &&
  typeof value.host === "string" &&
  typeof value.port === "number" &&
  typeof value.createdAt === "number";

const grantsFile = (stateDir: string) => stateLayout(stateDir).grants;

const lockFile = (stateDir: string) => stateLayout(stateDir).grantsLock;

export const readGrants = async (stateDir: string): Promise<Grant[]> => {
  const stored = await readJsonFile<unknown>(grantsFile(stateDir));

  return Array.isArray(stored) ? stored.filter(isGrant) : [];
};

const writeGrants = (stateDir: string, grants: Grant[]) =>
  writeJsonFile(grantsFile(stateDir), grants, { mode: PRIVATE_MODE });

const updateGrants = <T>(stateDir: string, change: (grants: Grant[]) => { grants: Grant[]; result: T }) =>
  withFileLock(lockFile(stateDir), async () => {
    const current = await readGrants(stateDir);
    const next = change(current);

    if (
      next.grants.length !== current.length ||
      next.grants.some((grant, index) => grant !== current[index])
    ) {
      await writeGrants(stateDir, next.grants);
    }

    return next.result;
  });

const grantFor = (request: GrantRequest, now: number): Grant => ({
  host: request.host.trim().toLowerCase(),
  port: request.port,
  ...(request.repoHash === undefined ? {} : { repoHash: request.repoHash }),
  createdAt: now,
});

const sameTarget = (left: Grant, right: Grant) =>
  left.host === right.host && left.port === right.port && left.repoHash === right.repoHash;

export const addGrant = async (stateDir: string, request: GrantRequest, now: number): Promise<Grant> => {
  const grant = grantFor(request, now);

  return updateGrants(stateDir, (grants) => ({
    grants: [...grants.filter((existing) => !sameTarget(existing, grant)), grant],
    result: grant,
  }));
};

const matches = (grant: Grant, match: GrantMatch) =>
  grant.host === match.host.trim().toLowerCase() &&
  (match.port === undefined || grant.port === match.port) &&
  grant.repoHash === match.repoHash;

export const revokeGrants = (stateDir: string, match: GrantMatch): Promise<number> =>
  updateGrants(stateDir, (grants) => {
    const kept = grants.filter((grant) => !matches(grant, match));

    return { grants: kept, result: grants.length - kept.length };
  });

export const activeGrants = (grants: Grant[], repoHash: string): Grant[] =>
  grants.filter((grant) => grant.repoHash === undefined || grant.repoHash === repoHash);

export const forgetRepoGrants = (stateDir: string, repoHash: string): Promise<number> =>
  updateGrants(stateDir, (grants) => {
    const kept = grants.filter((grant) => grant.repoHash !== repoHash);

    return { grants: kept, result: grants.length - kept.length };
  });

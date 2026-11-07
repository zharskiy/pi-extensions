import {
  isJsonObject,
  LauncherError,
  readJsonFile,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import type { ActiveGrantContext, Grant, GrantLimits, GrantMatch, GrantRequest } from "./types.ts";

export const SESSION_GRANT_CAP_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

const PRIVATE_MODE = 0o600;

const isGrant = (value: unknown): value is Grant =>
  isJsonObject(value) &&
  typeof value.host === "string" &&
  typeof value.port === "number" &&
  typeof value.createdAt === "number";

const grantsFile = (stateDir: string) => stateLayout(stateDir).grants;

const lockFile = (stateDir: string) => `${grantsFile(stateDir)}.lock`;

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

const checkLimits = (request: GrantRequest, limits: GrantLimits) => {
  if (!limits.enabled) {
    throw new LauncherError("egress grants are turned off by egress.grants.enabled");
  }

  if (request.scope.kind === "permanent" && !limits.permanent) {
    throw new LauncherError(
      "permanent egress grants are turned off by egress.grants.permanent",
      "use --hours N",
    );
  }

  if (request.scope.kind !== "hours") {
    return;
  }

  const { hours } = request.scope;

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new LauncherError(`--hours needs a positive number, got ${hours}`);
  }

  if (hours > limits.maxHours) {
    throw new LauncherError(`--hours ${hours} exceeds egress.grants.maxHours (${limits.maxHours})`);
  }
};

const sessionHours = (limits: GrantLimits) => Math.min(SESSION_GRANT_CAP_HOURS, limits.maxHours);

const grantFor = (request: GrantRequest, limits: GrantLimits, now: number): Grant => {
  const base = {
    host: request.host.trim().toLowerCase(),
    port: request.port,
    ...(request.repoHash === undefined ? {} : { repoHash: request.repoHash }),
    createdAt: now,
  };

  if (request.scope.kind === "session") {
    return { ...base, expiresAt: now + sessionHours(limits) * HOUR_MS, launchId: request.scope.launchId };
  }

  if (request.scope.kind === "hours") {
    return { ...base, expiresAt: now + request.scope.hours * HOUR_MS };
  }

  return base;
};

const sameTarget = (left: Grant, right: Grant) =>
  left.host === right.host &&
  left.port === right.port &&
  left.repoHash === right.repoHash &&
  left.launchId === right.launchId;

export const addGrant = async (
  stateDir: string,
  request: GrantRequest,
  limits: GrantLimits,
  now: number,
): Promise<Grant> => {
  checkLimits(request, limits);

  const grant = grantFor(request, limits, now);

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

const isLive = (grant: Grant, context: { now: number; liveLaunches: ReadonlySet<string> }) =>
  (grant.expiresAt === undefined || grant.expiresAt > context.now) &&
  (grant.launchId === undefined || context.liveLaunches.has(grant.launchId));

export const activeGrants = (grants: Grant[], context: ActiveGrantContext): Grant[] =>
  grants.filter(
    (grant) =>
      isLive(grant, context) && (grant.repoHash === undefined || grant.repoHash === context.repoHash),
  );

export const pruneGrants = (
  stateDir: string,
  context: { now: number; liveLaunches: ReadonlySet<string> },
): Promise<number> =>
  updateGrants(stateDir, (grants) => {
    const kept = grants.filter((grant) => isLive(grant, context));

    return { grants: kept, result: grants.length - kept.length };
  });

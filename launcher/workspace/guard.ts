import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isWithin, LauncherError, realOrResolvedSync } from "../shared/index.ts";
import { type Overlap, overlapOf, type Protected, protectedPaths } from "./mounts.ts";
import { sessionSlug } from "./pi-session-dir.ts";
import type { Workspace } from "./types.ts";

interface GuardContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

const HINT = "run pi inside a project directory";

const overlapsAs = (kinds: Overlap[], path: string) => (entry: Protected) => {
  const kind = overlapOf(path, entry);

  return kind !== undefined && kinds.includes(kind);
};

const firstOverlap = (mounted: string[], table: Protected[], kinds: Overlap[]) =>
  mounted
    .map((path) => ({ path, entry: table.find(overlapsAs(kinds, path)) }))
    .find((found) => found.entry !== undefined);

export const assertSafeMounts = (mounted: string[], context: GuardContext) => {
  const table = protectedPaths({ home: context.home, env: context.env });
  const covering = firstOverlap(mounted, table, ["is", "contains"]);

  if (covering?.entry !== undefined) {
    throw new LauncherError(
      `${covering.path} would mount ${covering.entry.path} into the sandbox, refusing`,
      HINT,
    );
  }

  const inside = firstOverlap(mounted, table, ["inside"]);

  if (inside?.entry !== undefined) {
    throw new LauncherError(
      `${inside.path} is inside ${inside.entry.path}, refusing to mount it into the sandbox`,
      HINT,
    );
  }
};

export const assertSafeWorkspace = (workspace: Workspace, context: GuardContext) =>
  assertSafeMounts(
    [workspace.repoRoot, workspace.gitCommonDir].filter((path) => path !== undefined),
    context,
  );

interface HostSessionsContext {
  home: string;
  agentDir: string;
  repoRoot: string;
}

const SLUG = /^--[^/]*--$/;

const SESSIONS_HINT = "set sessions.host to false in the user config";

const refuseSessions = (dir: string, reason: string) =>
  new LauncherError(`sessions: ${dir} ${reason}, refusing to mount it into the sandbox`, SESSIONS_HINT);

const realSessionsDir = (sessions: string) => {
  try {
    return realpathSync.native(sessions);
  } catch {
    return undefined;
  }
};

const agentEntries = (agentDir: string) => {
  try {
    return readdirSync(agentDir).filter((name) => name !== "sessions");
  } catch {
    return [];
  }
};

const protectedPiPaths = (context: HostSessionsContext) => {
  const agentDir = resolve(context.agentDir);

  return [
    { path: realOrResolvedSync(join(context.home, ".pi")), both: false },
    { path: realOrResolvedSync(agentDir), both: false },
    ...agentEntries(agentDir).map((name) => ({ path: realOrResolvedSync(join(agentDir, name)), both: true })),
  ];
};

export const assertHostSessionsDir = (dir: string, context: HostSessionsContext) => {
  const sessions = join(resolve(context.agentDir), "sessions");
  const slug = sessionSlug(context.repoRoot);

  if (!SLUG.test(slug) || dir !== join(sessions, slug)) {
    throw refuseSessions(dir, "is not pi's session directory of this repository");
  }

  const info = lstatSync(dir, { throwIfNoEntry: false });

  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw refuseSessions(dir, "is not a real directory");
  }

  const realSessions = realSessionsDir(sessions);

  const real = realOrResolvedSync(dir);

  if (realSessions === undefined || real !== join(realSessions, slug)) {
    throw refuseSessions(dir, "resolves outside pi's sessions directory");
  }

  const overlap = protectedPiPaths(context).find(
    ({ path, both }) => isWithin(path, real) || (both && isWithin(real, path)),
  );

  if (overlap !== undefined) {
    throw refuseSessions(dir, `resolves to a path that overlaps ${overlap.path}`);
  }
};

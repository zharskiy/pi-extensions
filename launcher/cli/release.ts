import type { VmBusy } from "../backend/index.ts";
import { othersLive, withLaunchLock } from "../grants/index.ts";
import { knownRepos } from "../shared/index.ts";
import { vmSessions } from "./busy.ts";
import { type CliDeps, writeLine } from "./deps.ts";
import { withGroundLock } from "./ground.ts";
import { whenNotPreparing } from "./prepare.ts";
import { removeRepoSandbox } from "./sweep.ts";

const releaseRepo = async (deps: CliDeps, stateDir: string, repoHash: string) => {
  const outcome = await whenNotPreparing(stateDir, repoHash, async () =>
    (await othersLive(stateDir, repoHash)) ? undefined : removeRepoSandbox(deps, repoHash),
  );

  return { repoHash, busy: outcome.busy || outcome.value === undefined };
};

export const releaseRepos = async (deps: CliDeps, stateDir: string) => {
  const known = await knownRepos(stateDir);

  return Promise.all(known.map((repoHash) => releaseRepo(deps, stateDir, repoHash)));
};

export const withInstallReleased = (deps: CliDeps, stateDir: string, release: () => Promise<void>) =>
  withGroundLock({ stateDir, progress: (line) => writeLine(deps.stderr, line) }, () =>
    withLaunchLock(stateDir, async (): Promise<VmBusy | undefined> => {
      const sessions = await vmSessions(deps.backend(), stateDir);

      if (sessions.count > 0) {
        return sessions;
      }

      await release();

      return undefined;
    }),
  );

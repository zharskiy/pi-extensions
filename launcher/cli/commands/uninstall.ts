import { busyText } from "../../backend/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { removeGround } from "../ground.ts";
import { releaseRepos, withInstallReleased } from "../release.ts";

export const releaseSandbox = async (
  deps: CliDeps,
  note: (line: string) => void,
  teardown: () => Promise<void>,
) => {
  const { stateDir } = pathsOf(deps);
  const sessions = await vmSessions(deps.backend(), stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(`${busyText(sessions)} in the sandbox VM`, "exit them, then run this again");
  }

  const released = await releaseRepos(deps, stateDir);

  released
    .filter((repo) => repo.busy)
    .forEach((repo) => {
      note(`A pi session of ${repo.repoHash.slice(0, 12)} started meanwhile; its sandbox stays`);
    });

  const busy = await withInstallReleased(deps, stateDir, async () => {
    await removeGround(deps, stateDir, undefined);

    await teardown();
  });

  if (busy !== undefined) {
    throw new LauncherError(
      `a pi session started in the sandbox VM meanwhile (${busyText(busy)}), so the sandbox network, proxy, services, volumes and images were kept`,
      "exit it, then run this again",
    );
  }
};

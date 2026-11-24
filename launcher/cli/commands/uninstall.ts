import { type Backend, busyText } from "../../backend/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { removeGround } from "../ground.ts";
import { releaseRepos, removeStored, withInstallReleased } from "../release.ts";

const reachableEngine = async (backend: Backend) =>
  (await backend.detect()).available ? backend : undefined;

const releaseInstall = (deps: CliDeps, stateDir: string, backend: Backend | undefined) =>
  withInstallReleased(deps, stateDir, async () => {
    await removeGround(deps, stateDir, backend);

    if (backend !== undefined) {
      await removeStored(backend).catch(() => undefined);
    }
  });

export const releaseSandbox = async (deps: CliDeps, note: (line: string) => void) => {
  const { stateDir } = pathsOf(deps);
  const sessions = await vmSessions(deps.backend(), stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(`${busyText(sessions)} in the sandbox VM`, "exit them, then run this again");
  }

  const backend = await reachableEngine(deps.backend());
  const { released } = await releaseRepos(deps, stateDir, backend);

  released
    .filter((repo) => repo.busy)
    .forEach((repo) => {
      note(`A pi session of ${repo.repoHash.slice(0, 12)} started meanwhile; its sandbox stays`);
    });

  const install = await releaseInstall(deps, stateDir, backend);

  if ("busy" in install) {
    throw new LauncherError(
      `a pi session started in the sandbox VM meanwhile (${busyText(install.busy)}), so the sandbox network, proxy, services, volumes and images were kept`,
      "exit it, then uninstall again",
    );
  }
};

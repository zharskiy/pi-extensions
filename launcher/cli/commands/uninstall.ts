import { type Backend, busyText } from "../../backend/index.ts";
import { errorMessage, LauncherError } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeLines } from "../deps.ts";
import { removeGround } from "../ground.ts";
import { type RepoRelease, releaseRepos, removeStored, withInstallReleased } from "../release.ts";

const startedMeanwhile = (repoHash: string) => [
  `host: a pi session of ${repoHash.slice(0, 12)} started meanwhile; its sandbox stays`,
];

const repoLines = (repo: RepoRelease) => (repo.busy ? startedMeanwhile(repo.repoHash) : repo.removed);

const releasedLines = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const { released, known } = await releaseRepos(deps, stateDir, backend);

  return [
    ...released.flatMap(repoLines),
    `host: released the created folders of ${known} ${known === 1 ? "folder" : "folders"}`,
  ];
};

const storedLines = async (backend: Backend) => {
  const stored = await removeStored(backend);

  return [`engine: removed ${stored.volumes.length} volumes and ${stored.images.length} images`];
};

const reachableEngine = async (backend: Backend) =>
  (await backend.detect()).available ? backend : undefined;

const releaseStored = (backend: Backend | undefined) =>
  backend === undefined
    ? Promise.resolve(["engine: the sandbox VM is not running, its objects go with the colima profile"])
    : storedLines(backend).catch((error: unknown) => [
        `engine: not cleaned (${errorMessage(error)}), its objects go with the colima profile`,
      ]);

const releaseInstall = (deps: CliDeps, stateDir: string, backend: Backend | undefined) =>
  withInstallReleased(deps, stateDir, async () => {
    const ground = await removeGround(deps, stateDir, backend);
    const stored = await releaseStored(backend);

    return [...ground.map((line) => `install: ${line}`), ...stored];
  });

export const releaseSandbox = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const sessions = await vmSessions(deps.backend(), stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(`${busyText(sessions)} in the sandbox VM`, "exit them, then run this again");
  }

  const backend = await reachableEngine(deps.backend());
  const released = await releasedLines(deps, stateDir, backend);
  const install = await releaseInstall(deps, stateDir, backend);

  writeLines(deps.stdout, released);

  if ("busy" in install) {
    throw new LauncherError(
      `a pi session started in the sandbox VM meanwhile (${busyText(install.busy)}), so the sandbox network, proxy, services, volumes and images were kept`,
      "exit it, then uninstall again",
    );
  }

  writeLines(deps.stdout, install.released);
};

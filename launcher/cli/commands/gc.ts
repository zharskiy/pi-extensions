import { access } from "node:fs/promises";
import type { Backend, ContainerSummary, VolumeSummary } from "../../backend/index.ts";
import { collectGarbage, LABELS, userHashOf } from "../../container/index.ts";
import { liveSessions } from "../../grants/index.ts";
import { removeRepoToken } from "../../proxy/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { openAdminContext, openBackend } from "../launch.ts";

const SHARED_CACHES = "--shared-caches";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const servesAny = async (stateDir: string, policyHash: string, repoHashes: string[]) =>
  (
    await Promise.all(
      repoHashes.map((repo) => exists(stateLayout(stateDir).proxyInstance(policyHash).repoToken(repo))),
    )
  ).some(Boolean);

const livePolicyHashes = async (stateDir: string, policyHashes: string[], repoHashes: string[]) => {
  const serving = await Promise.all(policyHashes.map((hash) => servesAny(stateDir, hash, repoHashes)));

  return policyHashes.filter((_hash, index) => serving[index]);
};

const reposWithContainers = async (backend: Backend) =>
  (await backend.findContainers({ [LABELS.managed]: "true" }))
    .filter((container) => container.labels[LABELS.relay] !== "true")
    .flatMap((container) => {
      const repoHash = container.labels[LABELS.repoHash];

      return repoHash === undefined ? [] : [repoHash];
    });

const removeTokens = (stateDir: string, removed: ContainerSummary[], policyHashes: string[]) =>
  Promise.all(
    removed.flatMap((container) => {
      const repoHash = container.labels[LABELS.repoHash];
      const own = container.labels[LABELS.proxyPolicyHash];
      const policies = [...new Set(own === undefined ? policyHashes : [...policyHashes, own])];

      return repoHash === undefined
        ? []
        : policies.map((policyHash) => removeRepoToken(stateDir, policyHash, repoHash));
    }),
  );

const orphaned = async (volume: VolumeSummary) => {
  const root = volume.labels[LABELS.repoRoot];

  return root !== undefined && !volume.inUse && !(await exists(root));
};

const sharedBy = (volume: VolumeSummary, userHash: string | undefined) =>
  userHash !== undefined && volume.labels[LABELS.userHash] === userHash;

const removedVolume = (backend: Backend, volume: VolumeSummary) =>
  backend.removeVolume(volume.name).then(
    () => [volume],
    (error: unknown) => {
      if (error instanceof LauncherError) {
        return [];
      }

      throw error;
    },
  );

const pruneVolumes = async (backend: Backend, sharedOwner: string | undefined) => {
  const volumes = await backend.listVolumes();
  const verdicts = await Promise.all(volumes.map(orphaned));
  const shared = volumes.filter((volume) => sharedBy(volume, sharedOwner));
  const removable = [
    ...volumes.filter((_volume, index) => verdicts[index]),
    ...shared.filter((volume) => !volume.inUse),
  ];
  const removed = (await Promise.all(removable.map((volume) => removedVolume(backend, volume)))).flat();

  return {
    removed: removed.filter((volume) => !sharedBy(volume, sharedOwner)).map((volume) => volume.name),
    shared: removed.filter((volume) => sharedBy(volume, sharedOwner)),
    sharedInUse: shared.filter((volume) => volume.inUse),
  };
};

const sharedLabel = (volume: VolumeSummary) => volume.labels[LABELS.sharedPath] ?? "unknown path";

const sharedLines = (volumes: { shared: VolumeSummary[]; sharedInUse: VolumeSummary[] }) => [
  ...volumes.shared.map((volume) => `removed shared cache ${volume.name} (${sharedLabel(volume)})`),
  ...volumes.sharedInUse.map((volume) => `kept shared cache ${volume.name} (${sharedLabel(volume)}), in use`),
];

const sharedOwnerOf = (args: string[], stateDir: string) => {
  const unknown = args.find((arg) => arg !== SHARED_CACHES);

  if (unknown !== undefined) {
    throw new LauncherError(`unknown gc option "${unknown}"`, `pi sandbox gc [${SHARED_CACHES}]`);
  }

  return args.includes(SHARED_CACHES) ? userHashOf(stateDir) : undefined;
};

export const gcCommand = async (deps: CliDeps, args: string[]) => {
  const sharedOwner = sharedOwnerOf(args, pathsOf(deps).stateDir);
  const { effective, stateDir } = await openAdminContext(deps);
  const backend = await openBackend(deps, effective.config);
  const instances = await deps.proxy.list(stateDir);
  const repoHashes = [...new Set((await liveSessions(stateDir)).map((session) => session.repoHash))];
  const policyHashes = await livePolicyHashes(
    stateDir,
    instances.map((instance) => instance.policyHash),
    repoHashes,
  );
  const garbage = await collectGarbage(backend, { repoHashes, policyHashes });
  const idle = instances.filter((instance) => !garbage.policyHashesInUse.includes(instance.policyHash));

  await removeTokens(
    stateDir,
    garbage.containers,
    instances.map((instance) => instance.policyHash),
  );

  await Promise.all(idle.map((instance) => deps.proxy.stop(stateDir, instance.policyHash)));

  const networks = await backend.pruneNetworks([
    ...new Set([...(await reposWithContainers(backend)), ...repoHashes]),
  ]);

  const volumes = await pruneVolumes(backend, sharedOwner);

  writeLines(deps.stdout, [
    ...garbage.containers.map((container) => `removed ${container.name} (${container.id})`),
    ...garbage.relays.map((relay) => `removed relay ${relay.name} (${relay.id})`),
    ...idle.map((instance) => `stopped proxy pid ${instance.pid} port ${instance.port}`),
    ...networks.map((name) => `removed network ${name}`),
    ...volumes.removed.map((name) => `removed volume ${name}`),
    ...sharedLines(volumes),
  ]);

  writeLine(deps.stdout, `removed ${plural(garbage.containers.length, "stopped container")}`);

  return 0;
};

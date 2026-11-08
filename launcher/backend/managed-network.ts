import { LABELS } from "./labels.ts";
import type { Backend, RemoveContainerOptions } from "./types.ts";

const NETWORK_PREFIX = "pi-sandbox";

const SHORT_REPO_HASH = 12;

const PRUNABLE_NETWORK = /^pi-sandbox-([0-9a-f]{12})$/;

export const repoNetworkName = (repoHash: string) =>
  `${NETWORK_PREFIX}-${repoHash.slice(0, SHORT_REPO_HASH)}`;

export const repoNetworkLabels = (repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash,
});

export const pruneCandidates = (names: string[], keepRepoHashes: string[]) => {
  const kept = new Set(keepRepoHashes.map((hash) => hash.slice(0, SHORT_REPO_HASH)));

  return names.filter((name) => {
    const match = PRUNABLE_NETWORK.exec(name);

    return match !== null && !kept.has(match[1] ?? "");
  });
};

interface NetworkCleanup {
  repoHashOf: (id: string) => Promise<string | undefined>;
  remove: (id: string) => Promise<void>;
  findContainers: Backend["findContainers"];
  removeNetwork: (name: string) => Promise<unknown>;
}

export const removeWithNetworkCleanup = async (
  cleanup: NetworkCleanup,
  id: string,
  options: RemoveContainerOptions = {},
) => {
  const repoHash = await cleanup.repoHashOf(id);

  await cleanup.remove(id);

  if (options.keepNetwork === true || repoHash === undefined) {
    return;
  }

  const remaining = await cleanup.findContainers({ [LABELS.repoHash]: repoHash });

  if (remaining.length === 0) {
    await cleanup.removeNetwork(repoNetworkName(repoHash));
  }
};

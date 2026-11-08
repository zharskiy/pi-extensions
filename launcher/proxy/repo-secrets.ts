import type { ControlMessage, ControlReply } from "./control.ts";
import type { ProxyRuntime } from "./runtime.ts";

type Repos = Pick<ProxyRuntime, "repoOfTokenHash" | "liveRepos">;

const EMPTY: ReadonlyMap<string, string> = new Map();

export const createRepoSecrets = (repos: Repos) => {
  const byRepo = new Map<string, ReadonlyMap<string, string>>();

  const prune = async () => {
    const live = await repos.liveRepos();

    [...byRepo.keys()]
      .filter((repoHash) => !live.has(repoHash))
      .forEach((repoHash) => {
        byRepo.delete(repoHash);
      });
  };

  const secretsOf = async (repoHash: string | undefined) => {
    await prune();

    return repoHash === undefined ? EMPTY : (byRepo.get(repoHash) ?? EMPTY);
  };

  const accept = async (message: ControlMessage): Promise<ControlReply> => {
    const repoHash = await repos.repoOfTokenHash(message.repoTokenHash);

    if (repoHash === undefined) {
      return { ok: false, error: "the control message names no live repository token" };
    }

    byRepo.set(repoHash, new Map(Object.entries(message.secrets)));

    await prune();

    return { ok: true };
  };

  return { secretsOf, accept };
};

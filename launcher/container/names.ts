import { repoHash, sha256Hex, shortHash } from "../shared/index.ts";

const CACHE_VOLUME_PREFIX = "pi-sandbox-cache-";

const shortRepoHash = (repoRoot: string) => shortHash(repoHash(repoRoot));

export const containerName = (repoRoot: string) => `pi-sandbox-${shortRepoHash(repoRoot)}`;

export const agentVolumeName = (user: string, repoRoot: string) =>
  `pi-sandbox-agent-${shortHash(sha256Hex(user))}-${shortRepoHash(repoRoot)}`;

export const cacheVolumeName = (repoRoot: string, path: string) =>
  `${CACHE_VOLUME_PREFIX}${shortRepoHash(repoRoot)}-${sha256Hex(path).slice(0, 8)}`;

export const userHashOf = (stateDir: string) => shortHash(sha256Hex(stateDir));

export const sharedVolumeName = (userHash: string, path: string) =>
  `pi-sandbox-shared-${userHash}-${sha256Hex(path).slice(0, 8)}`;

import { repoHash, sha256Hex, stateLayout } from "../shared/index.ts";

export { LABELS } from "../backend/index.ts";
export { repoHash } from "../shared/index.ts";

const SHORT = 12;

const shortRepoHash = (repoRoot: string) => repoHash(repoRoot).slice(0, SHORT);

export const containerName = (repoRoot: string) => `pi-sandbox-${shortRepoHash(repoRoot)}`;

export const agentVolumeName = (user: string, repoRoot: string) =>
  `pi-sandbox-agent-${sha256Hex(user).slice(0, SHORT)}-${shortRepoHash(repoRoot)}`;

export const cacheVolumeName = (repoRoot: string, path: string) =>
  `pi-sandbox-cache-${shortRepoHash(repoRoot)}-${sha256Hex(path).slice(0, 8)}`;

export const copiesDir = (stateDir: string, repoRoot: string) =>
  stateLayout(stateDir).copies(shortRepoHash(repoRoot));

export const userHashOf = (stateDir: string) => sha256Hex(stateDir).slice(0, SHORT);

export const sharedVolumeName = (userHash: string, path: string) =>
  `pi-sandbox-shared-${userHash}-${sha256Hex(path).slice(0, 8)}`;

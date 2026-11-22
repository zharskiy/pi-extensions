import { installIdOf } from "../backend/index.ts";
import { repoHash, sha256Hex, shortHash } from "../shared/index.ts";

const shortRepoHash = (repoRoot: string) => shortHash(repoHash(repoRoot));

const pathHash = (path: string) => sha256Hex(path).slice(0, 8);

export const containerName = (repoRoot: string, launchId: string) =>
  `pi-sandbox-${shortRepoHash(repoRoot)}-${launchId}`;

export const agentVolumeName = (install: string, repoRoot: string) =>
  `pi-sandbox-agent-${install}-${shortRepoHash(repoRoot)}`;

export const cacheVolumeName = (install: string, repoRoot: string, path: string) =>
  `pi-sandbox-cache-${install}-${shortRepoHash(repoRoot)}-${pathHash(path)}`;

export const configVolumeName = (stateDir: string, identity: string) =>
  `pi-sandbox-shared-${installIdOf(stateDir)}-${pathHash(identity)}`;

export const podName = (install: string) => `pi-sandbox-pod-${install}`;

export const serviceContainerName = (install: string, service: string) =>
  `pi-sandbox-service-${install}-${service}`;

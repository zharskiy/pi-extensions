import { installIdOf } from "../backend/index.ts";
import { repoHash, sha256Hex, shortHash } from "../shared/index.ts";

const shortRepoHash = (repoRoot: string) => shortHash(repoHash(repoRoot));

const pathHash = (path: string) => sha256Hex(path).slice(0, 8);

export const containerName = (repoRoot: string, launchId: string) =>
  `pinata-${shortRepoHash(repoRoot)}-${launchId}`;

export const agentVolumeName = (install: string) => `pinata-agent-${install}`;

export const configVolumeName = (stateDir: string, identity: string) =>
  `pinata-shared-${installIdOf(stateDir)}-${pathHash(identity)}`;

export const podName = (install: string) => `pinata-pod-${install}`;

export const serviceContainerName = (install: string, service: string) =>
  `pinata-service-${install}-${service}`;

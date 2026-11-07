import { join } from "node:path";
import { sha256Hex } from "../shared/index.ts";

export const LABELS = {
  managed: "pi-sandbox.managed",
  repoHash: "pi-sandbox.repo-hash",
  repoRoot: "pi-sandbox.repo-root",
  imageDigest: "pi-sandbox.image-digest",
  imageReference: "pi-sandbox.image-reference",
  configHash: "pi-sandbox.config-hash",
  specHash: "pi-sandbox.spec-hash",
  proxyPolicyHash: "pi-sandbox.proxy-policy-hash",
  relay: "pi-sandbox.relay",
  version: "pi-sandbox.version",
  sessionDir: "pi-sandbox.session-dir",
  gitProtection: "pi-sandbox.git-protection",
  gitCommonDir: "pi-sandbox.git-common-dir",
} as const;

const SHORT = 12;

export const repoHash = (repoRoot: string) => sha256Hex(repoRoot);

const shortRepoHash = (repoRoot: string) => repoHash(repoRoot).slice(0, SHORT);

export const containerName = (repoRoot: string) => `pi-sandbox-${shortRepoHash(repoRoot)}`;

export const agentVolumeName = (user: string, repoRoot: string) =>
  `pi-sandbox-agent-${sha256Hex(user).slice(0, SHORT)}-${shortRepoHash(repoRoot)}`;

export const cacheVolumeName = (repoRoot: string, path: string) =>
  `pi-sandbox-cache-${shortRepoHash(repoRoot)}-${sha256Hex(path).slice(0, 8)}`;

export const copiesDir = (stateDir: string, repoRoot: string) =>
  join(stateDir, "copies", shortRepoHash(repoRoot));

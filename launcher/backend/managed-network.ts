import { LABELS } from "./labels.ts";

const NETWORK_PREFIX = "pi-sandbox";

const SHORT_REPO_HASH = 12;

export const repoNetworkName = (repoHash: string) =>
  `${NETWORK_PREFIX}-${repoHash.slice(0, SHORT_REPO_HASH)}`;

export const relayName = (repoHash: string) =>
  `${NETWORK_PREFIX}-relay-${repoHash.slice(0, SHORT_REPO_HASH)}`;

export const repoNetworkLabels = (repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash,
});

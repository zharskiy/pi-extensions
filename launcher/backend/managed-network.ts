import { shortHash } from "../shared/index.ts";
import { LABELS } from "./labels.ts";

const NETWORK_PREFIX = "pi-sandbox";

export const RELAY_PREFIX = `${NETWORK_PREFIX}-relay-`;

export const repoNetworkName = (repoHash: string) => `${NETWORK_PREFIX}-${shortHash(repoHash)}`;

export const relayName = (repoHash: string) => `${RELAY_PREFIX}${shortHash(repoHash)}`;

export const repoNetworkLabels = (repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.repoHash]: repoHash,
});

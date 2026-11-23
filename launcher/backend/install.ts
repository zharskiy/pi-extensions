import { sha256Hex, shortHash } from "../shared/index.ts";

export const SERVICES_ALIAS = "pi-sandbox-services";

export const installIdOf = (stateDir: string) => shortHash(sha256Hex(stateDir));

export const networkName = (install: string) => `pi-sandbox-network-${install}`;

export const relayName = (install: string) => `pi-sandbox-relay-${install}`;

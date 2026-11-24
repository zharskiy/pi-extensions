import { sha256Hex, shortHash } from "../shared/index.ts";

export const SERVICES_ALIAS = "pinata-services";

export const installIdOf = (stateDir: string) => shortHash(sha256Hex(stateDir));

export const networkName = (install: string) => `pinata-network-${install}`;

export const relayName = (install: string) => `pinata-relay-${install}`;

import { type CredentialRule, matchesPattern, normalizeHost } from "../config/index.ts";
import { restrictedAddress } from "./policy.ts";

export type ResolveHost = (host: string) => Promise<string[]>;

export interface PrivateHostInput {
  rules: CredentialRule[];
  privateHosts: string[];
  resolve: ResolveHost;
}

const listedPrivate = (privateHosts: string[], host: string) =>
  privateHosts.some((pattern) => matchesPattern(normalizeHost(host), normalizeHost(pattern)));

const resolvesPrivately = async (resolve: ResolveHost, host: string) => {
  const addresses = await resolve(host).catch(() => []);

  return addresses.some((address) => restrictedAddress(address) !== undefined);
};

export const privateHostNotices = async (input: PrivateHostInput) => {
  const hosts = [...new Set(input.rules.map((rule) => rule.host))].filter(
    (host) => !listedPrivate(input.privateHosts, host),
  );
  const flags = await Promise.all(hosts.map((host) => resolvesPrivately(input.resolve, host)));

  return hosts
    .filter((_, index) => flags[index] === true)
    .map(
      (host) =>
        `${host} resolves to a private address; add it to egress.privateHosts so the sandbox may reach it`,
    );
};

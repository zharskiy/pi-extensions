import { isIP } from "node:net";
import type { CredentialRule } from "../config/index.ts";
import { matchesAnyHostPattern } from "./host-pattern.ts";

export type ResolveHost = (host: string) => Promise<string[]>;

export interface PrivateHostInput {
  rules: CredentialRule[];
  privateHosts: string[];
  resolve: ResolveHost;
}

const PRIVATE_V4: Array<[number, number, number]> = [
  [0, 0, 8],
  [10, 0, 8],
  [100, 64, 10],
  [127, 0, 8],
  [169, 254, 16],
  [172, 16, 12],
  [192, 168, 16],
];

const isPrivateV4 = (address: string) => {
  const [first = 0, second = 0] = address.split(".").map(Number);
  const value = first * 256 + second;

  return PRIVATE_V4.some(([a, b, bits]) => {
    const size = 2 ** (16 - Math.min(bits, 16));

    return Math.floor(value / size) === Math.floor((a * 256 + b) / size);
  });
};

const isPrivateV6 = (address: string) => {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);

  if (mapped?.[1] !== undefined) {
    return isPrivateV4(mapped[1]);
  }

  return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
};

export const isPrivateAddress = (address: string) => {
  const family = isIP(address);

  if (family === 4) {
    return isPrivateV4(address);
  }

  return family === 6 && isPrivateV6(address);
};

const resolvesPrivately = async (resolve: ResolveHost, host: string) => {
  const addresses = await resolve(host).catch(() => []);

  return addresses.some(isPrivateAddress);
};

export const privateHostNotices = async (input: PrivateHostInput) => {
  const hosts = [...new Set(input.rules.map((rule) => rule.host))].filter(
    (host) => !matchesAnyHostPattern(input.privateHosts, host),
  );
  const flags = await Promise.all(hosts.map((host) => resolvesPrivately(input.resolve, host)));

  return hosts
    .filter((_, index) => flags[index] === true)
    .map(
      (host) =>
        `${host} resolves to a private address; add it to egress.privateHosts so the sandbox may reach it`,
    );
};

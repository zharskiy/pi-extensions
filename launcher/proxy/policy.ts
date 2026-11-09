import { BlockList, isIP } from "node:net";
import {
  authorityOf,
  isLoopbackName,
  matchesPattern,
  normalizeHost,
  parseEntry,
  TLS_PORT,
} from "../config/index.ts";

export interface EgressPolicy {
  allow: string[];
  deny?: string[];
  credentialHosts?: string[];
  grants?: boolean;
}

export interface ConnectRequest {
  host: string;
  port: number;
  sni?: string;
}

export interface Denial {
  allowed: false;
  rule: string;
  reason: string;
}

export type ConnectDecision = { allowed: true } | Denial;

const METADATA_ADDRESS = "169.254.169.254";

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;

interface AddressRange {
  rule: string;
  reason: string;
  ranges: Array<[string, number, "ipv4" | "ipv6"]>;
}

const ADDRESS_RANGES: AddressRange[] = [
  { rule: "metadata", reason: "cloud metadata address", ranges: [[METADATA_ADDRESS, 32, "ipv4"]] },
  {
    rule: "loopback",
    reason: "loopback address",
    ranges: [
      ["127.0.0.0", 8, "ipv4"],
      ["::1", 128, "ipv6"],
    ],
  },
  {
    rule: "unspecified",
    reason: "unspecified address",
    ranges: [
      ["0.0.0.0", 8, "ipv4"],
      ["::", 128, "ipv6"],
    ],
  },
  {
    rule: "ipv4-compatible",
    reason: "IPv4-compatible IPv6 address",
    ranges: [["::", 96, "ipv6"]],
  },
  {
    rule: "translated-address",
    reason: "translated or tunnelled IPv6 address",
    ranges: [
      ["64:ff9b::", 96, "ipv6"],
      ["2002::", 16, "ipv6"],
    ],
  },
  {
    rule: "link-local",
    reason: "link-local address",
    ranges: [
      ["169.254.0.0", 16, "ipv4"],
      ["fe80::", 10, "ipv6"],
    ],
  },
  {
    rule: "private-address",
    reason: "private network address",
    ranges: [
      ["10.0.0.0", 8, "ipv4"],
      ["172.16.0.0", 12, "ipv4"],
      ["192.168.0.0", 16, "ipv4"],
      ["100.64.0.0", 10, "ipv4"],
      ["fc00::", 7, "ipv6"],
    ],
  },
  {
    rule: "reserved-address",
    reason: "reserved or special-purpose address",
    ranges: [
      ["192.0.0.0", 24, "ipv4"],
      ["198.18.0.0", 15, "ipv4"],
      ["240.0.0.0", 4, "ipv4"],
      ["255.255.255.255", 32, "ipv4"],
    ],
  },
  {
    rule: "multicast",
    reason: "multicast address",
    ranges: [
      ["224.0.0.0", 4, "ipv4"],
      ["ff00::", 8, "ipv6"],
    ],
  },
];

const blockLists = ADDRESS_RANGES.map((range) => {
  const list = new BlockList();

  range.ranges.forEach(([network, prefix, family]) => {
    list.addSubnet(network, prefix, family);
  });

  return { range, list };
});

const deny = (rule: string, reason: string): Denial => ({ allowed: false, rule, reason });

const mappedIpv4 = (address: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);

  return mapped === null ? address : mapped[1];
};

export const restrictedAddress = (address: string): Denial | undefined => {
  const plain = mappedIpv4(address.replace(/^\[|\]$/g, ""));
  const family = isIP(plain) === 4 ? "ipv4" : "ipv6";
  const match = blockLists.find(({ list }) => list.check(plain, family));

  return match === undefined ? undefined : deny(match.range.rule, `${plain} is a ${match.range.reason}`);
};

const notAllowed = (rule: string, host: string, port: number, grants: boolean) => {
  const target = authorityOf(host, port);

  return deny(
    rule,
    grants
      ? `${target} is not allowed by the sandbox. Ask the user to run pi sandbox egress allow ${target} on the host.`
      : `${target} is not allowed by the sandbox. Egress grants are off; ask the user to add it to egress.allow on the host.`,
  );
};

const policyHosts = (policy: EgressPolicy) => [...policy.allow, ...(policy.credentialHosts ?? [])];

const isDenied = (host: string, port: number, deny: string[]) =>
  deny.map(parseEntry).some((entry) => matchesPattern(host, entry.pattern) && (entry.port ?? port) === port);

const literalDecision = (host: string): Denial => {
  const restricted = restrictedAddress(host);

  return (
    restricted ?? deny("ip-literal", `${host} is an IP address; only allowlisted hostnames are reachable`)
  );
};

const isLiteral = (host: string) => isIP(host.replace(/^\[|\]$/g, "")) !== 0;

const isNumericHost = (host: string) => NUMERIC_LABEL.test(host.split(".").at(-1) ?? "");

const hostDecision = (host: string, port: number, policy: EgressPolicy, extra: string[]): ConnectDecision => {
  if (isLiteral(host)) {
    return literalDecision(host);
  }

  if (!HOSTNAME.test(host)) {
    return deny("hostname", `${host} is not a valid hostname`);
  }

  if (isNumericHost(host)) {
    return deny("ip-literal", `${host} looks like a numeric address`);
  }

  if (isLoopbackName(host)) {
    return deny("loopback", `${host} is a loopback name`);
  }

  if (isDenied(host, port, policy.deny ?? [])) {
    return deny("egress.deny", `${host} is in egress.deny`);
  }

  const entries = [...policyHosts(policy), ...extra]
    .map(parseEntry)
    .filter((entry) => matchesPattern(host, entry.pattern));

  if (entries.length === 0) {
    return notAllowed("egress.allow", host, port, policy.grants !== false);
  }

  if (!entries.some((entry) => (entry.port ?? TLS_PORT) === port)) {
    return notAllowed("egress.port", host, port, policy.grants !== false);
  }

  return { allowed: true };
};

export const sniDenial = (host: string, sni: string | undefined): Denial | undefined => {
  if (sni === undefined) {
    return deny("sni", "no TLS server name");
  }

  const name = normalizeHost(sni);
  const target = normalizeHost(host);

  return name === target ? undefined : deny("sni", `TLS server name ${name} does not match ${target}`);
};

export const decideConnect = (
  request: ConnectRequest,
  policy: EgressPolicy,
  extra: string[] = [],
): ConnectDecision => {
  const host = normalizeHost(request.host);
  const decision = hostDecision(host, request.port, policy, extra);

  if (!decision.allowed || request.sni === undefined) {
    return decision;
  }

  return sniDenial(host, request.sni) ?? decision;
};

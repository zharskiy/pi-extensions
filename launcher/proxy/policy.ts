import { BlockList, isIP } from "node:net";

export interface EgressPolicy {
  allow: string[];
  mcpHosts: string[];
  gatewayHost?: string;
  gatewayPort?: number;
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

const TLS_PORT = 443;

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

export const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

const ENTRY_PORT = /^(.+):(\d{1,5})$/;

const parseEntry = (entry: string) => {
  const withPort = ENTRY_PORT.exec(entry.trim());

  return withPort === null
    ? { pattern: normalizeHost(entry), port: TLS_PORT }
    : { pattern: normalizeHost(withPort[1] ?? ""), port: Number(withPort[2]) };
};

const matchesPattern = (host: string, pattern: string) => {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    const label = host.slice(0, -suffix.length);

    return host.endsWith(suffix) && label.length > 0 && !label.includes(".");
  }

  return host === pattern;
};

const policyHosts = (policy: EgressPolicy) => [
  ...policy.allow,
  ...policy.mcpHosts,
  ...(policy.gatewayHost === undefined ? [] : [`${policy.gatewayHost}:${policy.gatewayPort ?? TLS_PORT}`]),
];

export const isGatewayHost = (host: string, port: number, policy: EgressPolicy) =>
  policy.gatewayHost !== undefined &&
  normalizeHost(host) === normalizeHost(policy.gatewayHost) &&
  port === (policy.gatewayPort ?? TLS_PORT);

const literalDecision = (host: string): Denial => {
  const restricted = restrictedAddress(host);

  return (
    restricted ?? deny("ip-literal", `${host} is an IP address; only allowlisted hostnames are reachable`)
  );
};

const isLiteral = (host: string) => isIP(host.replace(/^\[|\]$/g, "")) !== 0;

const isNumericHost = (host: string) => NUMERIC_LABEL.test(host.split(".").at(-1) ?? "");

const isLocalhost = (host: string) => host === "localhost" || host.endsWith(".localhost");

const hostDecision = (host: string, port: number, policy: EgressPolicy): ConnectDecision => {
  if (isLiteral(host)) {
    return literalDecision(host);
  }

  if (!HOSTNAME.test(host)) {
    return deny("hostname", `${host} is not a valid hostname`);
  }

  if (isNumericHost(host)) {
    return deny("ip-literal", `${host} looks like a numeric address`);
  }

  if (isLocalhost(host)) {
    return deny("loopback", `${host} is a loopback name`);
  }

  const entries = policyHosts(policy)
    .map(parseEntry)
    .filter((entry) => matchesPattern(host, entry.pattern));

  if (entries.length === 0) {
    return deny("egress.allow", `${host} is not in egress.allow, egress.mcpHosts or the gateway`);
  }

  if (!entries.some((entry) => entry.port === port)) {
    const ports = entries.map((entry) => entry.port).join(", ");

    return deny("egress.port", `port ${port} is not allowed for ${host}; allowed: ${ports}`);
  }

  return { allowed: true };
};

export const decideConnect = (request: ConnectRequest, policy: EgressPolicy): ConnectDecision => {
  const host = normalizeHost(request.host);
  const decision = hostDecision(host, request.port, policy);

  if (!decision.allowed || request.sni === undefined) {
    return decision;
  }

  const sni = normalizeHost(request.sni);

  return sni === host ? decision : deny("sni", `TLS server name ${sni} does not match ${host}`);
};

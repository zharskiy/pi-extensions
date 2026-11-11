import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { connect, type LookupFunction, type Socket } from "node:net";
import { bypassesParent, dialViaParent, type ParentRoute } from "./parent.ts";
import { isPrivateNetworkAddress, restrictedAddress } from "./policy.ts";

export type DialAccess = "public" | "private-network" | "private";

export type Dial = (host: string, port: number, access: DialAccess) => Promise<Socket>;

export interface Dialer {
  dial: Dial;
  checkAddresses(host: string, access: DialAccess): Promise<void>;
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

export class RestrictedAddressError extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "RestrictedAddressError";
    this.rule = rule;
  }
}

const UNRESOLVED = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "EAI_NONAME"]);

const CONNECT_TIMEOUT_MS = 10_000;

const PRIVATE_RESOLUTION = new Set(["loopback", "link-local", "reserved-address", "private-address"]);

const resolutionRule = (rule: string | undefined) =>
  rule !== undefined && PRIVATE_RESOLUTION.has(rule) ? "private-address" : (rule ?? "resolve");

type AddressFilter = (hostname: string, addresses: LookupAddress[]) => LookupAddress[] | Error;

const reachableBy = (access: DialAccess) => (address: LookupAddress) =>
  restrictedAddress(address.address) === undefined ||
  (access === "private-network" && isPrivateNetworkAddress(address.address));

const addressesFor =
  (access: DialAccess): AddressFilter =>
  (hostname, addresses) => {
    if (access === "private") {
      return addresses;
    }

    const allowed = addresses.filter(reachableBy(access));

    if (allowed.length > 0) {
      return allowed;
    }

    const denial = addresses.map((address) => restrictedAddress(address.address)).find(Boolean);

    return new RestrictedAddressError(
      resolutionRule(denial?.rule),
      `${hostname} resolves only to restricted addresses${denial === undefined ? "" : ` (${denial.reason})`}`,
    );
  };

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error === null ? resolve(addresses) : reject(error),
    );
  });

const FAMILIES: Record<string, number> = { IPv4: 4, IPv6: 6 };

const ofFamily = (addresses: LookupAddress[], family: LookupOptions["family"]) => {
  const requested = typeof family === "string" ? FAMILIES[family] : family;

  return requested === undefined || requested === 0
    ? addresses
    : addresses.filter((entry) => entry.family === requested);
};

const lookupWith =
  (resolveHost: Resolve, filter: AddressFilter): LookupFunction =>
  (hostname, options, callback) => {
    resolveHost(hostname).then(
      (addresses) => {
        const result = filter(hostname, ofFamily(addresses, options.family));

        if (result instanceof Error) {
          callback(result, "", 0);

          return;
        }

        if (options.all === true) {
          callback(null, result);

          return;
        }

        callback(null, result[0]?.address ?? "", result[0]?.family ?? 4);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };

const connected = (socket: Socket, host: string, port: number, timeoutMs: number) =>
  new Promise<Socket>((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer);

      reject(error);
    };

    const timer = setTimeout(() => {
      socket.off("error", fail);

      socket.destroy();

      reject(new Error(`${host}:${port} did not accept the connection in time`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);

      socket.off("error", fail);

      resolve(socket);
    });

    socket.once("error", fail);
  });

const direct =
  (resolveHost: Resolve, timeoutMs: number) => (host: string, port: number, access: DialAccess) =>
    connected(
      connect({ host, port, lookup: lookupWith(resolveHost, addressesFor(access)) }),
      host,
      port,
      timeoutMs,
    );

const checkResolved = async (resolve: Resolve, host: string, access: DialAccess) => {
  const addresses = await resolve(host).catch((error: NodeJS.ErrnoException) => {
    if (UNRESOLVED.has(error.code ?? "")) {
      return [];
    }

    throw error;
  });

  const result = addresses.length === 0 ? addresses : addressesFor(access)(host, addresses);

  if (result instanceof Error) {
    throw result;
  }
};

export interface DialerOptions {
  parent?: ParentRoute;
  resolve?: Resolve;
  connectTimeoutMs?: number;
}

export const createDialer = ({
  parent,
  resolve: resolveHost = systemResolve,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
}: DialerOptions = {}): Dialer => {
  const dialDirect = direct(resolveHost, connectTimeoutMs);
  const checkAddresses = async (host: string, access: DialAccess) => {
    if (access !== "private") {
      await checkResolved(resolveHost, host, access);
    }
  };
  const dial: Dial = async (host, port, access) => {
    if (parent === undefined || bypassesParent(parent.noProxy, host)) {
      return dialDirect(host, port, access);
    }

    await checkAddresses(host, access);

    return dialViaParent(parent, host, port);
  };

  return { dial, checkAddresses };
};

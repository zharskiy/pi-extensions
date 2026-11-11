import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { connect, type LookupFunction, type Socket } from "node:net";
import { bypassesParent, dialViaParent, type ParentRoute } from "./parent.ts";
import { restrictedAddress } from "./policy.ts";

export type DialAccess = "public" | "private";

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

const publicAddresses = (hostname: string, addresses: LookupAddress[]) => {
  const allowed = addresses.filter((address) => restrictedAddress(address.address) === undefined);
  const denial = addresses.map((address) => restrictedAddress(address.address)).find(Boolean);

  if (allowed.length > 0) {
    return allowed;
  }

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
  (
    resolveHost: Resolve,
    filter: (hostname: string, addresses: LookupAddress[]) => LookupAddress[] | Error,
  ): LookupFunction =>
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
  (lookups: { public: LookupFunction; private: LookupFunction }, timeoutMs: number) =>
  (host: string, port: number, access: DialAccess) =>
    connected(
      connect({ host, port, lookup: access === "public" ? lookups.public : lookups.private }),
      host,
      port,
      timeoutMs,
    );

const checkResolved = async (resolve: Resolve, host: string) => {
  const addresses = await resolve(host).catch((error: NodeJS.ErrnoException) => {
    if (UNRESOLVED.has(error.code ?? "")) {
      return [];
    }

    throw error;
  });

  const result = addresses.length === 0 ? addresses : publicAddresses(host, addresses);

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
  const dialDirect = direct(
    {
      public: lookupWith(resolveHost, publicAddresses),
      private: lookupWith(resolveHost, (_, addresses) => addresses),
    },
    connectTimeoutMs,
  );
  const dial: Dial = async (host, port, access) => {
    if (parent === undefined || bypassesParent(parent.noProxy, host)) {
      return dialDirect(host, port, access);
    }

    if (access === "public") {
      await checkResolved(resolveHost, host);
    }

    return dialViaParent(parent, host, port);
  };

  const checkAddresses = async (host: string, access: DialAccess) => {
    if (access === "public") {
      await checkResolved(resolveHost, host);
    }
  };

  return { dial, checkAddresses };
};

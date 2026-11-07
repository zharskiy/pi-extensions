import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { connect, isIP, type LookupFunction, type Socket } from "node:net";
import { bypassesParent, dialViaParent, type ParentRoute } from "./parent.ts";
import { restrictedAddress } from "./policy.ts";

export type DialAccess = "public" | "private";

type Dial = (host: string, port: number, access: DialAccess, repoHash?: string) => Promise<Socket>;

export type Dialer = Dial & { checkAddresses?: (host: string, access: DialAccess) => Promise<void> };

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

type Overrides = ReadonlyMap<string, string>;

type LookupAll = (
  hostname: string,
  family: LookupOptions["family"],
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

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

const publicAddresses = (hostname: string, addresses: LookupAddress[]) => {
  const allowed = addresses.filter((address) => restrictedAddress(address.address) === undefined);
  const denial = addresses.map((address) => restrictedAddress(address.address)).find(Boolean);

  if (allowed.length > 0) {
    return allowed;
  }

  return new RestrictedAddressError(
    denial?.rule ?? "resolve",
    `${hostname} resolves only to restricted addresses${denial === undefined ? "" : ` (${denial.reason})`}`,
  );
};

const lookupAll =
  (overrides: Overrides): LookupAll =>
  (hostname, family, callback) => {
    const address = overrides.get(hostname.toLowerCase());

    if (address !== undefined) {
      callback(null, [{ address, family: isIP(address) }]);

      return;
    }

    dnsLookup(hostname, { all: true, family }, callback);
  };

const lookupWith =
  (
    resolveAll: LookupAll,
    filter: (hostname: string, addresses: LookupAddress[]) => LookupAddress[] | Error,
  ): LookupFunction =>
  (hostname, options, callback) => {
    resolveAll(hostname, options.family, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);

        return;
      }

      const result = filter(hostname, addresses);

      if (result instanceof Error) {
        callback(result, "", 0);

        return;
      }

      if (options.all === true) {
        callback(null, result);

        return;
      }

      callback(null, result[0]?.address ?? "", result[0]?.family ?? 4);
    });
  };

const systemResolve =
  (resolveAll: LookupAll): Resolve =>
  (hostname) =>
    new Promise((resolve, reject) => {
      resolveAll(hostname, undefined, (error, addresses) =>
        error === null ? resolve(addresses) : reject(error),
      );
    });

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
  overrides?: Overrides;
  connectTimeoutMs?: number;
}

export const createDialer = ({
  parent,
  resolve,
  overrides = new Map(),
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
}: DialerOptions = {}): Dialer => {
  const resolveAll = lookupAll(overrides);
  const dialDirect = direct(
    {
      public: lookupWith(resolveAll, publicAddresses),
      private: lookupWith(resolveAll, (_, addresses) => addresses),
    },
    connectTimeoutMs,
  );
  const resolveHost = resolve ?? systemResolve(resolveAll);
  const isDirect = (host: string) => parent === undefined || bypassesParent(parent.noProxy, host);

  const dial: Dial = async (host, port, access, repoHash) => {
    if (parent === undefined || isDirect(host)) {
      return dialDirect(host, port, access);
    }

    if (access === "public") {
      await checkResolved(resolveHost, host);
    }

    return dialViaParent(parent, host, port, repoHash);
  };

  const checkAddresses = async (host: string, access: DialAccess) => {
    if (access === "public") {
      await checkResolved(isDirect(host) ? systemResolve(resolveAll) : resolveHost, host);
    }
  };

  return Object.assign(dial, { checkAddresses });
};

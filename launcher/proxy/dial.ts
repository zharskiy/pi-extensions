import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { connect, type LookupFunction, type Socket } from "node:net";
import { bypassesParent, dialViaParent, type ParentRoute } from "./parent.ts";
import { restrictedAddress } from "./policy.ts";

export type DialAccess = "public" | "private";

export type Dialer = (host: string, port: number, access: DialAccess) => Promise<Socket>;

export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

export class RestrictedAddressError extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "RestrictedAddressError";
    this.rule = rule;
  }
}

const UNRESOLVED = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "EAI_NONAME"]);

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

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error !== null) {
      callback(error, "", 0);

      return;
    }

    const result = publicAddresses(hostname, addresses);

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

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error === null ? resolve(addresses) : reject(error),
    );
  });

const connected = (socket: Socket) =>
  new Promise<Socket>((resolve, reject) => {
    socket.once("connect", () => {
      socket.off("error", reject);

      resolve(socket);
    });

    socket.once("error", reject);
  });

const direct = (host: string, port: number, access: DialAccess) =>
  connected(access === "public" ? connect({ host, port, lookup: publicLookup }) : connect({ host, port }));

const checkBeforeParent = async (resolve: Resolve, host: string) => {
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
}

export const createDialer = ({ parent, resolve = systemResolve }: DialerOptions = {}): Dialer => {
  return async (host, port, access) => {
    if (parent === undefined || bypassesParent(parent.noProxy, host)) {
      return direct(host, port, access);
    }

    if (access === "public") {
      await checkBeforeParent(resolve, host);
    }

    return dialViaParent(parent, host, port);
  };
};

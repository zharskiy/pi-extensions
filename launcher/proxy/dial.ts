import { type LookupAddress, lookup } from "node:dns";
import { connect, type LookupFunction, type Socket } from "node:net";
import { restrictedAddress } from "./policy.ts";

type DialPurpose = "tunnel" | "gateway";

export type Dialer = (host: string, port: number, purpose: DialPurpose) => Socket;

export class RestrictedAddressError extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "RestrictedAddressError";
    this.rule = rule;
  }
}

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
  lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
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

export const defaultDialer: Dialer = (host, port, purpose) =>
  purpose === "tunnel" ? connect({ host, port, lookup: publicLookup }) : connect({ host, port });

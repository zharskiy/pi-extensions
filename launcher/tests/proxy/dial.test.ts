import { describe, expect, it } from "vitest";
import { createDialer, RestrictedAddressError } from "../../proxy/dial.ts";

const refusal = async (address: string) => {
  const { dial } = createDialer({
    resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
  });
  const error = await dial("named.test", 443, "public").catch((caught: unknown) => caught);

  return error instanceof RestrictedAddressError ? error.rule : "dialled";
};

describe("a name that resolves only to restricted addresses", () => {
  it.each([
    ["10.0.0.5", "private-address"],
    ["127.0.0.1", "private-address"],
    ["169.254.1.1", "private-address"],
    ["198.18.0.1", "private-address"],
    ["::1", "private-address"],
    ["169.254.169.254", "metadata"],
    ["64:ff9b::a00:1", "translated-address"],
  ])("refuses %s with the rule %s", async (address, rule) => {
    expect(await refusal(address)).toBe(rule);
  });

  it("keeps the range in the reason", async () => {
    const { dial } = createDialer({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });

    await expect(dial("named.test", 443, "public")).rejects.toThrow(
      "named.test resolves only to restricted addresses (127.0.0.1 is a loopback address)",
    );
  });
});

describe("a name allowed to resolve to private network addresses", () => {
  const check = async (address: string) => {
    const { checkAddresses } = createDialer({
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });

    return checkAddresses("gateway.corp.test", "private-network").then(
      () => "allowed",
      (error: unknown) => (error instanceof RestrictedAddressError ? error.message : "failed"),
    );
  };

  it.each(["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fd00::1", "93.184.216.34"])(
    "reaches %s",
    async (address) => {
      expect(await check(address)).toBe("allowed");
    },
  );

  it.each([
    ["127.0.0.1", "loopback address"],
    ["169.254.169.254", "cloud metadata address"],
    ["169.254.1.1", "link-local address"],
    ["198.18.0.1", "reserved or special-purpose address"],
    ["fec0::1", "private network address"],
    ["::1", "loopback address"],
  ])("still refuses %s", async (address, range) => {
    expect(await check(address)).toBe(
      `gateway.corp.test resolves only to restricted addresses (${address} is a ${range})`,
    );
  });

  it("accepts a name whose answers mix a restricted and a private network address", async () => {
    const { checkAddresses } = createDialer({
      resolve: async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
    });

    await expect(checkAddresses("gateway.corp.test", "private-network")).resolves.toBeUndefined();
  });
});

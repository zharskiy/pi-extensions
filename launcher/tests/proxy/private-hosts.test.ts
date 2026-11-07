import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { privateHostNotices } from "../../proxy/private-hosts.ts";

const rule = (host: string): CredentialRule => ({
  id: host,
  host,
  placeholder: "pi-sandbox-x",
  secret: { env: "X" },
});

const notice = (host: string) =>
  `${host} resolves to a private address; add it to egress.privateHosts so the sandbox may reach it`;

describe("privateHostNotices", () => {
  it("names rule hosts that resolve privately unless privateHosts lists them", async () => {
    const addresses: Record<string, string[]> = {
      "inside.corp.example": ["10.1.2.3"],
      "listed.corp.example": ["192.168.1.1"],
      "public.example": ["93.184.216.34"],
      "v6.corp.example": ["fd00::1"],
    };
    const notices = await privateHostNotices({
      rules: Object.keys(addresses).map(rule),
      privateHosts: ["listed.corp.example"],
      resolve: async (host) => addresses[host] ?? [],
    });

    expect(notices).toEqual([notice("inside.corp.example"), notice("v6.corp.example")]);
  });

  it("ignores hosts that do not resolve", async () => {
    const notices = await privateHostNotices({
      rules: [rule("gone.example")],
      privateHosts: [],
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });

    expect(notices).toEqual([]);
  });

  it("lets a wildcard cover one label only, as the proxy does", async () => {
    const notices = await privateHostNotices({
      rules: [rule("b.corp.example"), rule("a.b.corp.example")],
      privateHosts: ["*.corp.example"],
      resolve: async () => ["10.0.0.5"],
    });

    expect(notices).toEqual([notice("a.b.corp.example")]);
  });

  it("flags every address the proxy refuses to dial for a public host", async () => {
    const notices = await privateHostNotices({
      rules: [rule("meta.example"), rule("mapped.example")],
      privateHosts: [],
      resolve: async (host) => (host === "meta.example" ? ["169.254.169.254"] : ["::ffff:127.0.0.1"]),
    });

    expect(notices).toEqual([notice("meta.example"), notice("mapped.example")]);
  });
});

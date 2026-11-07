import { describe, expect, it } from "vitest";
import { decideConnect, type EgressPolicy, restrictedAddress } from "../../proxy/policy.ts";

const policy: EgressPolicy = {
  allow: ["registry.npmjs.org", "*.githubusercontent.com", "example.test:8443"],
  mcpHosts: ["mcp.example.com"],
  gatewayHost: "gateway.example.com",
};

const ruleFor = (host: string, port = 443, sni?: string) => {
  const decision = decideConnect({ host, port, sni }, policy);

  return decision.allowed ? "allowed" : decision.rule;
};

describe("decideConnect", () => {
  it.each([
    ["registry.npmjs.org", "allowed"],
    ["REGISTRY.npmjs.org.", "allowed"],
    ["mcp.example.com", "allowed"],
    ["gateway.example.com", "allowed"],
    ["raw.githubusercontent.com", "allowed"],
    ["a.b.githubusercontent.com", "egress.allow"],
    ["githubusercontent.com", "egress.allow"],
    ["evil.com", "egress.allow"],
    ["npmjs.org", "egress.allow"],
    ["localhost", "loopback"],
    ["api.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["[::1]", "loopback"],
    ["169.254.169.254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["[fe80::1]", "link-local"],
    ["10.1.2.3", "private-address"],
    ["172.16.0.1", "private-address"],
    ["172.31.255.255", "private-address"],
    ["192.168.1.1", "private-address"],
    ["[fd00::1]", "private-address"],
    ["[::ffff:10.0.0.1]", "private-address"],
    ["8.8.8.8", "ip-literal"],
    ["[2001:4860:4860::8888]", "ip-literal"],
    ["2130706433", "ip-literal"],
    ["0x7f.1", "ip-literal"],
    ["bad host", "hostname"],
  ])("%s -> %s", (host, expected) => {
    expect(ruleFor(host)).toBe(expected);
  });

  it("refuses ports other than 443", () => {
    expect(ruleFor("registry.npmjs.org", 22)).toBe("egress.port");
  });

  it("allows an entry with an explicit port only on that port", () => {
    expect(ruleFor("example.test", 8443)).toBe("allowed");

    expect(ruleFor("example.test", 443)).toBe("egress.port");
  });

  it("keeps a bare entry on 443 only", () => {
    expect(ruleFor("registry.npmjs.org", 8443)).toBe("egress.port");
  });

  it("allows the gateway on the port of its URL only", () => {
    const gatewayPolicy = {
      allow: [],
      mcpHosts: ["mcp.example.com:9443"],
      gatewayHost: "gateway.corp",
      gatewayPort: 8443,
    };

    expect(decideConnect({ host: "gateway.corp", port: 8443 }, gatewayPolicy)).toEqual({ allowed: true });

    expect(decideConnect({ host: "gateway.corp", port: 443 }, gatewayPolicy)).toMatchObject({
      rule: "egress.port",
    });

    expect(decideConnect({ host: "mcp.example.com", port: 9443 }, gatewayPolicy)).toEqual({ allowed: true });
  });

  it("accepts a matching SNI case-insensitively", () => {
    expect(ruleFor("registry.npmjs.org", 443, "Registry.NPMJS.org")).toBe("allowed");
  });

  it("refuses an SNI that differs from the CONNECT host even when the SNI is allowlisted", () => {
    expect(ruleFor("registry.npmjs.org", 443, "mcp.example.com")).toBe("sni");
  });

  it("explains the denial", () => {
    expect(decideConnect({ host: "evil.com", port: 443 }, policy)).toEqual({
      allowed: false,
      rule: "egress.allow",
      reason: expect.stringContaining("evil.com"),
    });
  });
});

describe("denial hint under a grant cap", () => {
  const capped: EgressPolicy = { ...policy, grantCap: ["*.corp.test", "tools.test:8443"] };

  it("offers egress allow only for a host the cap still lets a grant reach", () => {
    expect(decideConnect({ host: "api.corp.test", port: 443 }, capped)).toMatchObject({
      reason: "pi-sandbox: api.corp.test is not allowed; run pi sandbox egress allow api.corp.test",
    });
    expect(decideConnect({ host: "tools.test", port: 8443 }, capped)).toMatchObject({
      reason: "pi-sandbox: tools.test:8443 is not allowed; run pi sandbox egress allow tools.test:8443",
    });
  });

  it("names the policy or org allowlist for a host outside the cap", () => {
    expect(decideConnect({ host: "evil.test", port: 443 }, capped)).toEqual({
      allowed: false,
      rule: "egress.allow",
      reason: "pi-sandbox: evil.test is outside the allowlist set by policy or org",
    });
    expect(decideConnect({ host: "tools.test", port: 443 }, capped)).toMatchObject({
      reason: "pi-sandbox: tools.test is outside the allowlist set by policy or org",
    });
  });
});

describe("restrictedAddress", () => {
  it("passes public addresses and flags resolved private ones", () => {
    expect(restrictedAddress("93.184.216.34")).toBeUndefined();

    expect(restrictedAddress("192.168.0.10")?.rule).toBe("private-address");

    expect(restrictedAddress("::ffff:127.0.0.1")?.rule).toBe("loopback");

    expect(restrictedAddress("::ffff:7f00:1")?.rule).toBe("loopback");

    expect(restrictedAddress("2606:4700::1111")).toBeUndefined();
  });

  it.each([
    ["::8.8.8.8", "ipv4-compatible"],
    ["::7f00:1", "ipv4-compatible"],
    ["64:ff9b::a00:1", "translated-address"],
    ["2002:c0a8:101::1", "translated-address"],
    ["198.18.0.1", "reserved-address"],
    ["198.19.255.255", "reserved-address"],
    ["192.0.0.8", "reserved-address"],
    ["240.0.0.1", "reserved-address"],
    ["255.255.255.255", "reserved-address"],
  ])("refuses %s as %s", (address, rule) => {
    expect(restrictedAddress(address)?.rule).toBe(rule);
  });
});

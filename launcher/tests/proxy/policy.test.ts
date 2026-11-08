import { describe, expect, it } from "vitest";
import { decideConnect, type EgressPolicy, restrictedAddress, sniDenial } from "../../proxy/policy.ts";

const policy: EgressPolicy = {
  allow: ["registry.npmjs.org", "*.githubusercontent.com", "example.test:8443", "mcp.example.com"],
  credentialHosts: ["llm.example.com:8443"],
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

  it("allows a credential rule host on the port of its rule only", () => {
    expect(ruleFor("llm.example.com", 8443)).toBe("allowed");

    expect(ruleFor("llm.example.com", 443)).toBe("egress.port");
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

describe("denial hint", () => {
  it("offers egress allow while grants are on", () => {
    expect(decideConnect({ host: "tools.test", port: 8443 }, policy)).toMatchObject({
      reason: "pi-sandbox: tools.test:8443 is not allowed; run pi sandbox egress allow tools.test:8443",
    });
  });

  it("points at egress.allow when grants are off", () => {
    expect(decideConnect({ host: "evil.test", port: 443 }, { ...policy, grants: false })).toEqual({
      allowed: false,
      rule: "egress.allow",
      reason: "pi-sandbox: evil.test is not allowed; egress grants are off, add it to egress.allow",
    });
  });
});

const guarded: EgressPolicy = {
  allow: ["registry.npmjs.org"],
  deny: ["evil.test", "*.blocked.test", "ports.test:8443"],
  credentialHosts: ["rules.test"],
};

const guardedRule = (host: string, port = 443, extra: string[] = []) => {
  const decision = decideConnect({ host, port }, guarded, extra);

  return decision.allowed ? "allowed" : decision.rule;
};

describe("decideConnect with deny, rule hosts and extra entries", () => {
  it("allows the host of a configured credential rule", () => {
    expect(guardedRule("rules.test")).toBe("allowed");
  });

  it("allows an extra entry such as a grant or derived host", () => {
    expect(guardedRule("granted.test", 443, ["granted.test"])).toBe("allowed");
    expect(guardedRule("granted.test", 8443, ["granted.test:8443"])).toBe("allowed");
  });

  it("lets egress.deny win over an extra entry on any port", () => {
    expect(guardedRule("evil.test", 443, ["evil.test"])).toBe("egress.deny");
    expect(guardedRule("a.blocked.test", 443, ["a.blocked.test"])).toBe("egress.deny");
    expect(guardedRule("ports.test", 8443, ["ports.test:8443"])).toBe("egress.deny");
    expect(guardedRule("ports.test", 443, ["ports.test"])).toBe("allowed");
  });

  it("keeps IP literals and loopback names denied with an extra entry", () => {
    expect(guardedRule("10.0.0.1", 443, ["10.0.0.1"])).toBe("private-address");
    expect(guardedRule("localhost", 443, ["localhost"])).toBe("loopback");
  });

  it("carries the allow hint in the denial reason", () => {
    expect(decideConnect({ host: "new.test", port: 443 }, guarded)).toMatchObject({
      reason: "pi-sandbox: new.test is not allowed; run pi sandbox egress allow new.test",
    });
  });
});

describe("sniDenial", () => {
  it("refuses a ClientHello without a server name", () => {
    expect(sniDenial("api.test", undefined)).toEqual({
      allowed: false,
      rule: "sni",
      reason: "no TLS server name",
    });
  });

  it("refuses a server name that differs from the CONNECT host", () => {
    expect(sniDenial("api.test", "other.test")).toEqual({
      allowed: false,
      rule: "sni",
      reason: "TLS server name other.test does not match api.test",
    });
  });

  it("passes a matching name in any case and with a trailing dot", () => {
    expect(sniDenial("api.test", "API.Test.")).toBeUndefined();
  });

  it("passes a host reached only through a grant, since it checks the name and not the allowlist", () => {
    expect(decideConnect({ host: "granted.test", port: 443 }, guarded).allowed).toBe(false);
    expect(sniDenial("granted.test", "granted.test")).toBeUndefined();
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

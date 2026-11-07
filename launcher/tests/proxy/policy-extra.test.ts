import { describe, expect, it } from "vitest";
import { decideConnect, type EgressPolicy } from "../../proxy/policy.ts";

const policy: EgressPolicy = {
  allow: ["registry.npmjs.org"],
  mcpHosts: [],
  deny: ["evil.test", "*.blocked.test", "ports.test:8443"],
  credentialHosts: ["rules.test"],
};

const ruleFor = (host: string, port = 443, extra: string[] = []) => {
  const decision = decideConnect({ host, port }, policy, extra);

  return decision.allowed ? "allowed" : decision.rule;
};

describe("decideConnect with deny, rule hosts and extra entries", () => {
  it("allows the host of a configured credential rule", () => {
    expect(ruleFor("rules.test")).toBe("allowed");
  });

  it("allows an extra entry such as a grant or derived host", () => {
    expect(ruleFor("granted.test", 443, ["granted.test"])).toBe("allowed");
    expect(ruleFor("granted.test", 8443, ["granted.test:8443"])).toBe("allowed");
  });

  it("lets egress.deny win over an extra entry on any port", () => {
    expect(ruleFor("evil.test", 443, ["evil.test"])).toBe("egress.deny");
    expect(ruleFor("a.blocked.test", 443, ["a.blocked.test"])).toBe("egress.deny");
    expect(ruleFor("ports.test", 8443, ["ports.test:8443"])).toBe("egress.deny");
    expect(ruleFor("ports.test", 443, ["ports.test"])).toBe("allowed");
  });

  it("keeps IP literals and loopback names denied with an extra entry", () => {
    expect(ruleFor("10.0.0.1", 443, ["10.0.0.1"])).toBe("private-address");
    expect(ruleFor("localhost", 443, ["localhost"])).toBe("loopback");
  });

  it("carries the allow hint in the denial reason", () => {
    expect(decideConnect({ host: "new.test", port: 443 }, policy)).toMatchObject({
      reason: "pi-sandbox: new.test is not allowed; run pi sandbox egress allow new.test",
    });
  });
});

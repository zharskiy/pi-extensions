import { describe, expect, it } from "vitest";
import { LEGACY_GATEWAY_RULE_ID, legacyGatewayRule } from "../../config/index.ts";

const gateway = {
  url: "https://llm.corp.test",
  authHeader: "x-api-key",
  placeholder: "pi-sandbox-placeholder",
  providers: [{ id: "corp", apiKind: "example-messages" }],
};

const ruleWith = (secret: unknown, overrides: Record<string, unknown> = {}) => ({
  id: LEGACY_GATEWAY_RULE_ID,
  host: "llm.corp.test",
  placeholder: "pi-sandbox-placeholder",
  header: "x-api-key",
  template: "{secret}",
  secret,
  ...overrides,
});

describe("legacyGatewayRule", () => {
  it("gives no rule without a gateway", () => {
    expect(legacyGatewayRule({ credentials: { kind: "host-pi-auth" } }, {})).toBeUndefined();
  });

  it("maps host-pi-auth onto the first gateway provider's pi credential", () => {
    expect(legacyGatewayRule({ gateway, credentials: { kind: "host-pi-auth" } }, {})).toEqual(
      ruleWith({ piAuth: "corp" }),
    );
  });

  it("maps host-pi-auth with an auth file onto a pointer at the provider key", () => {
    expect(
      legacyGatewayRule({ gateway, credentials: { kind: "host-pi-auth", authFile: "~/corp/auth.json" } }, {}),
    ).toEqual(ruleWith({ file: "~/corp/auth.json", pointer: "/corp/key" }));
  });

  it("maps static onto the variable when it is set, otherwise onto the keychain command", () => {
    const credentials = { kind: "static" as const, envVar: "GATEWAY_KEY", keychainService: "corp-gw" };

    expect(legacyGatewayRule({ gateway, credentials }, { GATEWAY_KEY: "value" })).toEqual(
      ruleWith({ env: "GATEWAY_KEY" }),
    );
    expect(legacyGatewayRule({ gateway, credentials }, {})).toEqual(
      ruleWith({ command: ["security", "find-generic-password", "-s", "corp-gw", "-w"] }),
    );
    expect(
      legacyGatewayRule({ gateway, credentials: { kind: "static", envVar: "GATEWAY_KEY" } }, {}),
    ).toEqual(ruleWith({ env: "GATEWAY_KEY" }));
    expect(legacyGatewayRule({ gateway, credentials: { kind: "static" } }, {})).toBeUndefined();
  });

  it("maps sso onto a command and keeps a non-default gateway port", () => {
    expect(
      legacyGatewayRule(
        {
          gateway: { ...gateway, url: "https://LLM.corp.test:8443/v1" },
          credentials: { kind: "sso", command: ["corp-sso", "token"] },
        },
        {},
      ),
    ).toEqual(ruleWith({ command: ["corp-sso", "token"] }, { port: 8443 }));
  });
});

import { describe, expect, it } from "vitest";
import { validateLayer } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";

const problemOf = (value: unknown, layer = "user") => {
  try {
    validateLayer(value, layer);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("validateLayer", () => {
  it("accepts a complete layer and returns it", () => {
    const layer = {
      $schema: "../schema/sandbox-config.schema.json",
      profile: "team",
      backend: "colima",
      fallback: "refuse",
      image: { reference: "ghcr.io/acme/pi:1", digest: `sha256:${"a".repeat(64)}` },
      gateway: {
        url: "https://llm.acme.test",
        authHeader: "x-api-key",
        placeholder: "pi-sandbox-placeholder",
        providers: [{ id: "gateway", apiKind: "example-messages" }],
      },
      credentials: { kind: "sso", command: ["acme-sso", "token"] },
      egress: {
        allow: ["github.com", "*.acme.test", "git.acme.test:2222", "*.acme.test:8443"],
        mcpHosts: ["mcp.acme.test"],
        denyPrivateAddresses: true,
      },
      workspaceRoots: { roots: ["~/work", "/srv/repos"], outside: "warn" },
      mounts: { extraReadOnly: ["/opt/tools"], cacheVolumes: ["node_modules", ".venv"] },
      env: { allow: ["TERM", "EDITOR"] },
      ssh: { agent: false },
      resources: { cpus: 4, memoryGiB: 8 },
    };

    expect(validateLayer(layer, "user")).toEqual(layer);
  });

  it("reports unknown keys with the layer and the dotted key", () => {
    expect(problemOf({ egres: {} }, "policy")).toBe("policy: egres is not a known key");
    expect(problemOf({ egress: { allowed: [] } }, "project")).toBe(
      "project: egress.allowed is not a known key",
    );
    expect(problemOf({ credentials: { kind: "static", file: "/x" } })).toBe(
      "user: credentials.file is not a known key",
    );
  });

  it("reports wrong types with the layer and the key", () => {
    expect(problemOf({ backend: "docker" })).toBe("user: backend must be one of auto, colima, apple");
    expect(problemOf({ egress: { allow: "github.com" } })).toBe("user: egress.allow must be an array");
    expect(problemOf({ egress: { allow: ["https://github.com"] } })).toBe(
      "user: egress.allow[0] https://github.com is not a host name or host:port",
    );
    expect(problemOf({ egress: { allow: ["github.com:70000"] } })).toBe(
      "user: egress.allow[0] github.com:70000 has a port outside 1-65535",
    );
    expect(problemOf({ egress: { allow: ["github.com:"] } })).toBe(
      "user: egress.allow[0] github.com: is not a host name or host:port",
    );
    expect(problemOf({ egress: { denyPrivateAddresses: false } })).toBe(
      "user: egress.denyPrivateAddresses must be true",
    );
    expect(problemOf({ resources: { cpus: 0 } })).toBe("user: resources.cpus must be greater than 0");
    expect(problemOf({ ssh: { agent: "yes" } })).toBe("user: ssh.agent must be true or false");
    expect(problemOf({ image: { digest: "latest" } })).toBe(
      "user: image.digest must look like sha256:<64 hex digits>",
    );
    expect(problemOf({ mounts: { cacheVolumes: ["../outside"] } })).toBe(
      "user: mounts.cacheVolumes[0] ../outside must be a relative path inside the repository",
    );
    expect(problemOf({ mounts: { extraReadOnly: ["relative"] } })).toBe(
      "user: mounts.extraReadOnly[0] relative must be an absolute path or start with ~/",
    );
  });

  it("checks the credential source by kind", () => {
    expect(problemOf({ credentials: { kind: "vault" } })).toBe(
      "user: credentials.kind must be one of static, host-pi-auth, sso",
    );
    expect(problemOf({ credentials: { kind: "sso" } })).toBe("user: credentials.command is required");
    expect(problemOf({ credentials: { kind: "static", envVar: "GATEWAY_API_KEY" } })).toBeUndefined();
  });

  it("checks the gateway", () => {
    const gateway = { url: "http://llm.acme.test", authHeader: "x-api-key", placeholder: "p", providers: [] };

    expect(problemOf({ gateway })).toBe("user: gateway.url must be an https URL");
    expect(problemOf({ gateway: { url: "https://llm.acme.test" } })).toBe(
      "user: gateway.authHeader is required",
    );
    expect(
      problemOf({ gateway: { ...gateway, url: "https://x.test", providers: [{ id: "a", apiKind: " " }] } }),
    ).toBe("user: gateway.providers[0].apiKind must not be empty");
    expect(
      problemOf({ gateway: { ...gateway, url: "https://x.test", providers: [{ id: "a", apiKind: 7 }] } }),
    ).toContain("gateway.providers[0].apiKind");
    expect(
      problemOf({
        gateway: { ...gateway, url: "https://x.test", providers: [{ id: "a", apiKind: "any-api-name" }] },
      }),
    ).toBeUndefined();
  });

  it("refuses forwarding environment variables that look like secrets", () => {
    expect(problemOf({ env: { allow: ["EDITOR", "GITHUB_TOKEN"] } }, "project")).toBe(
      "project: env.allow[1] GITHUB_TOKEN looks like a secret and stays on the host",
    );
    ["AWS_SECRET_ACCESS_KEY", "npm_password", "MY_CREDENTIALS", "GATEWAY_API_KEY"].forEach((name) => {
      expect(problemOf({ env: { allow: [name] } })).toContain("looks like a secret");
    });
  });

  it("requires a JSON object", () => {
    expect(problemOf([], "policy")).toBe("policy: must be a JSON object");
  });
});

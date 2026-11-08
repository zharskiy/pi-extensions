import { describe, expect, it } from "vitest";
import { validateLayer } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";

const SECRET_VALUE = "sk-live-value-that-must-not-leak";

const problemOf = (value: unknown, layer = "user") => {
  try {
    validateLayer(value, layer);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: "corp-llm",
  host: "llm.corp.test",
  placeholder: "pi-sandbox-corp",
  secret: { env: "CORP_LLM_KEY" },
  ...overrides,
});

const FULL_LAYER = {
  credentials: {
    rules: [
      rule(),
      rule({
        id: "git",
        host: "git.corp.test",
        port: 8443,
        pathPrefix: "/repos",
        placeholder: undefined,
        header: "authorization",
        template: "Basic {secret}",
      }),
      rule({ id: "npm", header: "authorization", template: "Bearer {secret}", secret: { piAuth: "corp" } }),
      rule({ id: "file", secret: { file: "~/.corp/token.json", pointer: "/token" } }),
      rule({ id: "cmd", secret: { command: ["security", "find-generic-password", "-w"], ttlSeconds: 60 } }),
      rule({ id: "mcp", secret: { mcpOAuth: { server: "docs", url: "https://mcp.corp.test/mcp" } } }),
      rule({ id: "bearer", secret: { piAuth: "corp", bearer: true } }),
    ].map((entry) => JSON.parse(JSON.stringify(entry))),
    derive: { enabled: false, hosts: ["*.corp.test", "api.example.test"] },
  },
  egress: {
    deny: ["paste.example.test", "*.tracker.test:8443"],
    privateHosts: ["*.corp.internal", "git.corp.internal"],
    parentProxy: "none",
    grants: true,
  },
  tls: { extraCa: [{ file: "/etc/corp/ca.pem" }, { hostStore: true }] },
  image: {
    packages: ["chromium", "libnss3=2:3.87-1"],
    npmGlobal: ["@scope/tool@1.2.3", "plain@0.1.0-beta.1"],
    dockerfile: "/etc/pi-sandbox/layer.Dockerfile",
  },
  org: "/etc/pi-sandbox/org.json",
};

describe("validateLayer with the credential, egress, tls, image and org keys", () => {
  it("accepts every new key in the policy and user layers and returns the layer", () => {
    expect(validateLayer(FULL_LAYER, "policy")).toEqual(FULL_LAYER);
    expect(validateLayer(FULL_LAYER, "user")).toEqual(FULL_LAYER);
  });

  it("accepts the new keys in the org layer except org itself", () => {
    const { org: _org, ...baseline } = FULL_LAYER;

    expect(validateLayer(baseline, "org")).toEqual(baseline);
    expect(problemOf(FULL_LAYER, "org")).toBe("org: org may only be set by the policy or user config");
  });

  it("accepts credentials as rules and derive only", () => {
    expect(problemOf({ credentials: { rules: [rule()] } })).toBeUndefined();
    expect(problemOf({ credentials: { derive: { enabled: false } } })).toBeUndefined();
    expect(problemOf({ credentials: { kind: "static" } })).toBe("user: credentials.kind is not a known key");
  });

  it("refuses every key outside the project allowlist, naming the key and the layer", () => {
    const cases: Array<[unknown, string]> = [
      [{ credentials: { rules: [rule()] } }, "credentials.rules"],
      [{ credentials: { derive: { enabled: false } } }, "credentials.derive.enabled"],
      [{ egress: { allow: ["x.test"] } }, "egress.allow"],
      [{ egress: { deny: ["x.test"] } }, "egress.deny"],
      [{ egress: { privateHosts: ["x.test"] } }, "egress.privateHosts"],
      [{ egress: { parentProxy: "none" } }, "egress.parentProxy"],
      [{ egress: { grants: false } }, "egress.grants"],
      [{ tls: { extraCa: [] } }, "tls.extraCa"],
      [{ image: { packages: ["git"] } }, "image.packages"],
      [{ image: { npmGlobal: ["tool@1.0.0"] } }, "image.npmGlobal"],
      [{ image: { dockerfile: "/x" } }, "image.dockerfile"],
      [{ fallback: "host" }, "fallback"],
      [{ workspaceRoots: { roots: ["/srv"], outside: "warn" } }, "workspaceRoots.roots"],
      [{ mounts: { extraReadOnly: ["/opt"] } }, "mounts.extraReadOnly"],
      [{ sessions: { host: false } }, "sessions.host"],
      [{ org: "/etc/org.json" }, "org"],
    ];

    cases.forEach(([layer, key]) => {
      expect(problemOf(layer, "project")).toBe(`project: ${key} may not be set by a project config`);
    });
  });

  it("refuses malformed rules with the dotted key", () => {
    const cases: Array<[unknown, string]> = [
      [{ id: "a" }, "credentials.rules[0].host is required"],
      [rule({ id: "has space" }), "credentials.rules[0].id must be letters, digits, dot, dash or underscore"],
      [rule({ host: "*.corp.test" }), "credentials.rules[0].host must be a host name"],
      [rule({ host: "10.0.0.1" }), "credentials.rules[0].host must be a host name"],
      [rule({ port: 70000 }), "credentials.rules[0].port must be at most 65535"],
      [rule({ port: 1.5 }), "credentials.rules[0].port must be a whole number"],
      [rule({ pathPrefix: "repos" }), "credentials.rules[0].pathPrefix must start with /"],
      [rule({ placeholder: "corp" }), "credentials.rules[0].placeholder must start with pi-sandbox-"],
      [rule({ header: "x-key", template: "{token}" }), "credentials.rules[0].template must contain {secret}"],
      [rule({ placeholder: undefined }), "credentials.rules[0] needs a placeholder or a header"],
      [rule({ template: "{secret}" }), "credentials.rules[0] template needs a header"],
      [
        rule({ secret: {} }),
        "credentials.rules[0].secret must set one of env, file, command, piAuth, mcpOAuth",
      ],
      [rule({ secret: { env: "A", piAuth: "b" } }), "credentials.rules[0].secret.piAuth is not a known key"],
      [rule({ secret: { command: [] } }), "credentials.rules[0].secret.command must not be empty"],
      [
        rule({ secret: { file: "rel.json", pointer: "/a" } }),
        "credentials.rules[0].secret.file must be an absolute path or start with ~/",
      ],
      [
        rule({ secret: { file: "/a.json", pointer: "a" } }),
        "credentials.rules[0].secret.pointer must be a JSON pointer",
      ],
      [
        rule({ secret: { mcpOAuth: { server: "docs", url: "http://mcp.test" } } }),
        "credentials.rules[0].secret.mcpOAuth.url must be an https URL",
      ],
    ];

    cases.forEach(([entry, message]) => {
      expect(problemOf({ credentials: { rules: [JSON.parse(JSON.stringify(entry))] } })).toBe(
        `user: ${message}`,
      );
    });
  });

  it("refuses duplicate rule ids", () => {
    expect(problemOf({ credentials: { rules: [rule(), rule()] } })).toBe(
      "user: credentials.rules has a duplicate id",
    );
  });

  it("refuses private hosts that are IP literals or loopback", () => {
    expect(problemOf({ egress: { privateHosts: ["10.1.2.3"] } })).toBe(
      "user: egress.privateHosts[0] must be a host name or *.domain, not an IP address",
    );
    expect(problemOf({ egress: { privateHosts: ["::1"] } })).toBe(
      "user: egress.privateHosts[0] must be a host name or *.domain, not an IP address",
    );
    expect(problemOf({ egress: { privateHosts: ["localhost"] } })).toBe(
      "user: egress.privateHosts[0] must not name loopback",
    );
    expect(problemOf({ egress: { privateHosts: ["db.localhost"] } })).toBe(
      "user: egress.privateHosts[0] must not name loopback",
    );
  });

  it("checks the parent proxy, grants, extra CA, image and org shapes", () => {
    const cases: Array<[unknown, string]> = [
      [{ egress: { parentProxy: "auto" } }, "egress.parentProxy must be one of env, none"],
      [{ egress: { parentProxy: { url: "http://proxy.test:3128" } } }, "egress.parentProxy must be a string"],
      [{ egress: { grants: { enabled: true } } }, "egress.grants must be true or false"],
      [{ egress: { deny: ["https://x.test"] } }, "egress.deny[0] must be a host name or host:port"],
      [{ tls: { extraCa: [{ hostStore: false }] } }, "tls.extraCa[0].hostStore must be true"],
      [{ tls: { extraCa: [{ url: "https://ca.test" }] } }, "tls.extraCa[0] must set one of file, hostStore"],
      [{ image: { packages: ["Bad Name"] } }, "image.packages[0] must be a package name"],
      [
        { image: { npmGlobal: ["tool"] } },
        "image.npmGlobal[0] must be an npm name@version, no URL, path or git source",
      ],
      [
        { image: { npmGlobal: ["git+https://x.test/t.git"] } },
        "image.npmGlobal[0] must be an npm name@version, no URL, path or git source",
      ],
      [
        { image: { npmGlobal: ["tool@latest"] } },
        "image.npmGlobal[0] must be an npm name@version, no URL, path or git source",
      ],
      [
        { image: { dockerfile: "layer.Dockerfile" } },
        "image.dockerfile must be an absolute path or start with ~/",
      ],
      [{ org: { source: "/etc/org.json" } }, "org must be a string"],
      [{ org: "https://config.test/a.json" }, "org must be an absolute path"],
      [{ org: "~/org.json" }, "org must be an absolute path"],
      [{ image: { registry: { host: "r.test" } } }, "image.registry is not a known key"],
    ];

    cases.forEach(([layer, message]) => {
      expect(problemOf(layer)).toBe(`user: ${message}`);
    });
  });

  it("never puts a configured value into a message", () => {
    const layers = [
      { egress: { parentProxy: `http://user:${SECRET_VALUE}@proxy.test:3128` } },
      { credentials: { rules: [rule({ placeholder: SECRET_VALUE })] } },
      { credentials: { rules: [rule({ header: "x-key", template: SECRET_VALUE })] } },
      { egress: { privateHosts: [`${SECRET_VALUE}:1`] } },
      { egress: { deny: [`${SECRET_VALUE}/path`] } },
      { org: SECRET_VALUE },
      { image: { npmGlobal: [SECRET_VALUE] } },
    ];

    layers.forEach((layer) => {
      const message = problemOf(layer) ?? "";

      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET_VALUE);
    });
  });
});

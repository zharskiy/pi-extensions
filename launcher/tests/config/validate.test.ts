import { describe, expect, it } from "vitest";
import { validateConfig } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";

const problemOf = (value: unknown) => {
  try {
    validateConfig(value);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("validateConfig", () => {
  it("accepts a complete config and returns it", () => {
    const config = {
      $schema: "../schema/sandbox-config.schema.json",
      image: { reference: "ghcr.io/acme/pi:1", digest: `sha256:${"a".repeat(64)}` },
      egress: {
        allow: ["github.com", "*.acme.test", "git.acme.test:2222", "*.acme.test:8443"],
      },
      workspaceRoots: { roots: ["~/work", "/srv/repos"] },
      mounts: { sharedCaches: ["~/.npm"], autoOverlays: false },
      env: { allow: ["TERM", "EDITOR"] },
      resources: { cpus: 4, memoryGiB: 8 },
    };

    expect(validateConfig(config)).toEqual(config);
  });

  it("reports unknown keys with the dotted key", () => {
    expect(problemOf({ egres: {} })).toBe("config: egres is not a known key");
    expect(problemOf({ egress: { allowed: [] } })).toBe("config: egress.allowed is not a known key");
    expect(problemOf({ credentials: { file: "/x" } })).toBe("config: credentials.file is not a known key");
  });

  it("reports wrong types with the key", () => {
    expect(problemOf({ egress: { allow: "github.com" } })).toBe("config: egress.allow must be an array");
    expect(problemOf({ egress: { allow: ["https://github.com"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(problemOf({ egress: { allow: ["github.com:70000"] } })).toBe(
      "config: egress.allow[0] has a port that is not a number from 1 to 65535",
    );
    expect(problemOf({ egress: { allow: ["github.com:"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(problemOf({ resources: { cpus: 0 } })).toBe("config: resources.cpus must be greater than 0");
    expect(problemOf({ ssh: { agent: true } })).toBe("config: ssh is not a known key");
    expect(problemOf({ image: { digest: "latest" } })).toBe(
      "config: image.digest must look like sha256:<64 hex digits>",
    );
    expect(problemOf({ workspaceRoots: { roots: ["relative"] } })).toBe(
      "config: workspaceRoots.roots[0] relative must be an absolute path or start with ~/",
    );
  });

  it("reads egress entries with one host grammar: underscores and any case, no IP, loopback, port 80 or padded port", () => {
    expect(problemOf({ egress: { allow: ["a_b.Corp.test", "*.svc_x.test:8443"] } })).toBeUndefined();
    expect(
      [
        "10.0.0.5",
        "10.0.0.5:8443",
        "::1",
        "foo.123",
        "localhost",
        "db.localhost:8443",
        "a.test:80",
        "a.test:00443",
        "a.test:0x50",
        "a.test.",
        `${"a".repeat(64)}.test`,
      ].map((entry) => problemOf({ egress: { deny: [entry] } })),
    ).toEqual([
      "config: egress.deny[0] must not be an IP address",
      "config: egress.deny[0] must not be an IP address",
      "config: egress.deny[0] must not be an IP address",
      "config: egress.deny[0] must not be an IP address",
      "config: egress.deny[0] must not name loopback",
      "config: egress.deny[0] must not name loopback",
      "config: egress.deny[0] names port 80, and plain HTTP is never forwarded",
      "config: egress.deny[0] has a port that is not a number from 1 to 65535",
      "config: egress.deny[0] must be a host name or host:port",
      "config: egress.deny[0] must be a host name or host:port",
      "config: egress.deny[0] must be a host name or host:port",
    ]);
  });

  it("refuses the removed keys", () => {
    expect(problemOf({ mounts: { cacheVolumes: ["node_modules"] } })).toBe(
      "config: mounts.cacheVolumes is not a known key",
    );
    expect(problemOf({ mounts: { hostCaches: ["maven"] } })).toBe(
      "config: mounts.hostCaches is not a known key",
    );
    expect(problemOf({ mounts: { extraReadOnly: ["/opt"] } })).toBe(
      "config: mounts.extraReadOnly is not a known key",
    );
    expect(problemOf({ workspaceRoots: { roots: ["/srv"], outside: "warn" } })).toBe(
      "config: workspaceRoots.outside is not a known key",
    );
    expect(problemOf({ workspaceRoots: {} })).toBe("config: workspaceRoots.roots is required");
  });

  it("says what replaces each removed key", () => {
    expect(problemOf({ fallback: "host" })).toBe(
      "config: fallback was removed; --no-sandbox is always available",
    );
    expect(problemOf({ egress: { presets: ["npm"] } })).toBe(
      "config: egress.presets was removed; list the hosts in egress.allow, see REMOVED-DEFAULTS.md",
    );
    expect(problemOf({ egress: { grants: true } })).toBe(
      "config: egress.grants was removed; grants are always on",
    );
    expect(problemOf({ egress: { parentProxy: "auto" } })).toBe(
      "config: egress.parentProxy was removed; the parent proxy is always taken from the environment",
    );
  });

  it("drops a trailing slash from shared caches", () => {
    expect(validateConfig({ mounts: { sharedCaches: ["~/.npm/"] } })).toEqual({
      mounts: { sharedCaches: ["~/.npm"] },
    });
  });

  it("refuses forwarding environment variables that look like secrets", () => {
    expect(problemOf({ env: { allow: ["EDITOR", "GITHUB_TOKEN"] } })).toBe(
      "config: env.allow[1] GITHUB_TOKEN looks like a secret and stays on the host",
    );
    [
      "AWS_SECRET_ACCESS_KEY",
      "npm_password",
      "MY_CREDENTIALS",
      "GATEWAY_API_KEY",
      "DB_PASSWD",
      "GPG_PASSPHRASE",
      "SESSION_JWT",
    ].forEach((name) => {
      expect(problemOf({ env: { allow: [name] } })).toContain("looks like a secret");
    });
  });

  it("refuses forwarding a variable the launcher sets inside the container", () => {
    [
      "HTTPS_PROXY",
      "http_proxy",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "PI_SANDBOX",
      "PATH",
    ].forEach((name) => {
      expect(problemOf({ env: { allow: [name] } })).toBe(
        `config: env.allow[0] ${name} is set by the launcher and is not forwarded`,
      );
    });
  });

  it("names the value of a path, name or choice leaf, escaped when it is not printable, and never a host or credential value", () => {
    expect(problemOf({ mounts: { sharedCaches: ["~/a/\u001b[31m/.."] } })).toBe(
      'config: mounts.sharedCaches[0] "~/a/\\u001b[31m/.." must name a directory below ~ without empty, . or .. segments',
    );
    expect(problemOf({ workspaceRoots: { roots: ["x".repeat(300)] } })).toBe(
      `config: workspaceRoots.roots[0] ${"x".repeat(200)}... must be an absolute path or start with ~/`,
    );
    expect(problemOf({ egress: { allow: ["https://user:sk-live@x.test"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(
      problemOf({
        credentials: {
          rules: [{ id: "r", host: "x.test", header: "a", template: "sk-live", secret: { env: "A" } }],
        },
      }),
    ).toBe("config: credentials.rules[0].template must contain {secret}");
  });

  it("requires a JSON object", () => {
    expect(problemOf([])).toBe("config: must be a JSON object");
  });
});

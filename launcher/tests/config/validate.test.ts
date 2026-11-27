import { describe, expect, it } from "vitest";
import { configProblem, validateConfig } from "../../config/index.ts";

describe("validateConfig", () => {
  it("accepts a complete config and returns it", () => {
    const config = {
      $schema: "../schema/sandbox-config.schema.json",
      image: { reference: "ghcr.io/acme/pi:1", digest: `sha256:${"a".repeat(64)}` },
      egress: {
        allow: ["github.com", "*.acme.test", "git.acme.test:2222", "*.acme.test:8443"],
      },
      workspaceRoot: "~/work",
      mounts: { volumes: ["~/.npm"], binds: [{ source: "~/ref", target: "/srv/ref" }] },
      setup: [["npm", "ci"]],
      env: { allow: ["TERM", "EDITOR"] },
      resources: { cpus: 4, memoryGiB: 8 },
    };

    expect(validateConfig(config)).toEqual(config);
  });

  it("reports unknown keys with the dotted key", () => {
    expect(configProblem({ egres: {} })).toBe("config: egres is not a known key");
    expect(configProblem({ egress: { allowed: [] } })).toBe("config: egress.allowed is not a known key");
    expect(configProblem({ credentials: { file: "/x" } })).toBe(
      "config: credentials.file is not a known key",
    );
  });

  it("escapes control, bidi and line separator characters of the keys and values it echoes", () => {
    expect(configProblem({ "a‮b\u007f\u0085 ": 1 })).toBe(
      "config: a\\u202Eb\\u007F\\u0085\\u2028 is not a known key",
    );
    expect(configProblem({ workspaceRoot: "rel\u007f‎" })).toBe(
      'config: workspaceRoot "rel\\u007F\\u200E" must be an absolute path or start with ~/',
    );
    expect(configProblem({ writeBack: { exclude: { "settings.json": ["x‮"] } } })).toBe(
      'config: writeBack.exclude["settings.json"][0] "x\\u202E" is not a built-in write-back key of settings.json',
    );
  });

  it("reports wrong types with the key", () => {
    expect(configProblem({ egress: { allow: "github.com" } })).toBe("config: egress.allow must be an array");
    expect(configProblem({ egress: { allow: ["https://github.com"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(configProblem({ egress: { allow: ["github.com:70000"] } })).toBe(
      "config: egress.allow[0] has a port that is not a number from 1 to 65535",
    );
    expect(configProblem({ egress: { allow: ["github.com:"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(configProblem({ resources: { cpus: 0 } })).toBe("config: resources.cpus must be greater than 0");
    expect(configProblem({ ssh: { agent: true } })).toBe("config: ssh is not a known key");
    expect(configProblem({ image: { digest: "latest" } })).toBe(
      "config: image.digest must look like sha256:<64 hex digits>",
    );
    expect(configProblem({ workspaceRoot: "relative" })).toBe(
      "config: workspaceRoot relative must be an absolute path or start with ~/",
    );
    expect(configProblem({ workspaceRoot: 3 })).toBe("config: workspaceRoot must be a string");
  });

  it("refuses the home dir as the workspace root and takes a folder on another volume", () => {
    expect(configProblem({ workspaceRoot: "~" })).toBe(
      "config: workspaceRoot ~ is the home dir, which would share all of it with the sandbox VM",
    );
    expect(configProblem({ workspaceRoot: "~/" })).toBe(
      "config: workspaceRoot ~/ is the home dir, which would share all of it with the sandbox VM",
    );
    expect(configProblem({ workspaceRoot: "/Volumes/Projects" })).toBeUndefined();
    expect(configProblem({ workspaceRoot: "~/work" })).toBeUndefined();
  });

  it("reads egress entries with one host grammar: underscores and any case, no IP, loopback, port 80 or padded port", () => {
    expect(configProblem({ egress: { allow: ["a_b.Corp.test", "*.svc_x.test:8443"] } })).toBeUndefined();
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
      ].map((entry) => configProblem({ egress: { deny: [entry] } })),
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

  it("takes an extra CA by sha256 fingerprint, colons and case optional", () => {
    const bare = "ab".repeat(32);
    const colons = Array.from({ length: 32 }, () => "AB").join(":");

    expect(
      configProblem({ tls: { extraCa: [{ sha256: bare }, { sha256: colons }, { file: "~/ca.pem" }] } }),
    ).toBe(undefined);
    expect(configProblem({ tls: { extraCa: [{ sha256: "ab".repeat(31) }] } })).toBe(
      "config: tls.extraCa[0].sha256 must be 64 hex digits, colons optional",
    );
    expect(configProblem({ tls: { extraCa: [{ sha256: `${"ab".repeat(31)}zz` }] } })).toBe(
      "config: tls.extraCa[0].sha256 must be 64 hex digits, colons optional",
    );
    expect(configProblem({ tls: { extraCa: [{ sha256: `:${bare}` }] } })).toBe(
      "config: tls.extraCa[0].sha256 must be 64 hex digits, colons optional",
    );
    expect(configProblem({ tls: { extraCa: [{ sha256: bare, file: "~/ca.pem" }] } })).toBe(
      "config: tls.extraCa[0].file is not a known key",
    );
  });

  it("drops a trailing slash from volume targets", () => {
    expect(validateConfig({ mounts: { volumes: ["~/.npm/"] } })).toEqual({
      mounts: { volumes: ["~/.npm"] },
    });
  });

  it("refuses forwarding environment variables that look like secrets", () => {
    expect(configProblem({ env: { allow: ["EDITOR", "GITHUB_TOKEN"] } })).toBe(
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
      expect(configProblem({ env: { allow: [name] } })).toContain("looks like a secret");
    });
  });

  it("refuses forwarding a variable the launcher sets inside the container", () => {
    [
      "HTTPS_PROXY",
      "http_proxy",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "PINATA",
      "PATH",
    ].forEach((name) => {
      expect(configProblem({ env: { allow: [name] } })).toBe(
        `config: env.allow[0] ${name} is set by pinata and is not forwarded`,
      );
    });
  });

  it("sets literal env.set values and refuses a name the launcher sets, naming the key", () => {
    expect(configProblem({ env: { set: { CI: "1", PATH_EXTRA: "$HOME/bin", EMPTY: "" } } })).toBeUndefined();
    expect(
      configProblem({ env: { set: { JAVA_TOOL_OPTIONS: "-Dhttps.proxyHost=pinata-proxy" } } }),
    ).toBeUndefined();
    expect(configProblem({ env: { set: { GH_TOKEN: "pinata-github" } } })).toBeUndefined();
    expect(configProblem({ env: { set: { GIT_OPTIONAL_LOCKS: "1" } } })).toBeUndefined();
    ["HTTPS_PROXY", "no_proxy", "GITLAB_TOKEN", "PINATA", "HOME", "PATH"].forEach((name) => {
      expect(configProblem({ env: { set: { CI: "1", [name]: "x" } } })).toBe(
        `config: env.set["${name}"] is set by pinata and cannot be set`,
      );
    });
    expect(configProblem({ env: { set: { "1BAD": "x" } } })).toBe(
      'config: env.set["1BAD"] is not an environment variable name',
    );
    expect(configProblem({ env: { set: { CI: 1 } } })).toBe('config: env.set["CI"] must be a string');
    expect(configProblem({ env: { set: { CI: "a\u0000b" } } })).toBe(
      'config: env.set["CI"] must not contain a NUL character',
    );
    expect(configProblem({ env: { set: ["CI=1"] } })).toBe("config: env.set must be an object");
  });

  it("bounds the pids, open files and shm limits and takes whole numbers only", () => {
    expect(configProblem({ resources: { pids: 256, openFiles: 1048576, shmMiB: 1 } })).toBeUndefined();
    expect(configProblem({ resources: { pids: 255 } })).toBe("config: resources.pids must be at least 256");
    expect(configProblem({ resources: { openFiles: 1048577 } })).toBe(
      "config: resources.openFiles must be at most 1048576",
    );
    expect(configProblem({ resources: { openFiles: 1023 } })).toBe(
      "config: resources.openFiles must be at least 1024",
    );
    expect(configProblem({ resources: { shmMiB: 0 } })).toBe("config: resources.shmMiB must be at least 1");
    expect(configProblem({ resources: { shmMiB: 64.5 } })).toBe(
      "config: resources.shmMiB must be a whole number",
    );
  });

  it("names the value of a path, name or choice leaf, escaped when it is not printable, and never a host or credential value", () => {
    expect(configProblem({ mounts: { volumes: ["~/a/\u001b[31m/.."] } })).toBe(
      'config: mounts.volumes[0] "~/a/\\u001b[31m/.." must not hold empty, . or .. segments',
    );
    expect(configProblem({ workspaceRoot: "x".repeat(300) })).toBe(
      `config: workspaceRoot ${"x".repeat(200)}... must be an absolute path or start with ~/`,
    );
    expect(configProblem({ egress: { allow: ["https://user:sk-live@x.test"] } })).toBe(
      "config: egress.allow[0] must be a host name or host:port",
    );
    expect(
      configProblem({
        credentials: {
          rules: [{ id: "r", host: "x.test", header: "a", template: "sk-live", secret: { env: "A" } }],
        },
      }),
    ).toBe("config: credentials.rules[0].template must contain {secret}");
  });

  it("requires a JSON object", () => {
    expect(configProblem([])).toBe("config: must be a JSON object");
  });
});

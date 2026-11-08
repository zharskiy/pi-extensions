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
      fallback: "refuse",
      image: { reference: "ghcr.io/acme/pi:1", digest: `sha256:${"a".repeat(64)}` },
      egress: {
        allow: ["github.com", "*.acme.test", "git.acme.test:2222", "*.acme.test:8443"],
      },
      workspaceRoots: { roots: ["~/work", "/srv/repos"], outside: "warn" },
      mounts: { extraReadOnly: ["/opt/tools"], cacheVolumes: ["node_modules", ".venv"] },
      env: { allow: ["TERM", "EDITOR"] },
      resources: { cpus: 4, memoryGiB: 8 },
    };

    expect(validateLayer(layer, "user")).toEqual(layer);
  });

  it("reports unknown keys with the layer and the dotted key", () => {
    expect(problemOf({ egres: {} }, "policy")).toBe("policy: egres is not a known key");
    expect(problemOf({ egress: { allowed: [] } }, "project")).toBe(
      "project: egress.allowed is not a known key",
    );
    expect(problemOf({ credentials: { file: "/x" } })).toBe("user: credentials.file is not a known key");
  });

  it("reports wrong types with the layer and the key", () => {
    expect(problemOf({ fallback: "docker" })).toBe("user: fallback must be one of refuse, host");
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
    expect(problemOf({ resources: { cpus: 0 } })).toBe("user: resources.cpus must be greater than 0");
    expect(problemOf({ ssh: { agent: true } })).toBe("user: ssh is not a known key");
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

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { mergeLayers } from "../../config/merge.ts";
import { createLayers } from "./fixtures.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

const GATEWAY = {
  url: "https://llm.acme.test",
  authHeader: "x-api-key",
  placeholder: "pi-sandbox-placeholder",
  providers: [{ id: "acme", apiKind: "example-messages" }],
};

const loadWith = async (layers: { policy?: unknown; user?: unknown; project?: unknown }) => {
  const files = await createLayers();

  if (layers.policy !== undefined) {
    await files.policy(layers.policy);
  }

  if (layers.user !== undefined) {
    await files.user(layers.user);
  }

  if (layers.project !== undefined) {
    await files.project(layers.project);
  }

  return loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });
};

describe("loadEffectiveConfig", () => {
  it("returns the defaults when no layer file exists", async () => {
    const { config, sources } = await loadWith({});

    expect(config).toEqual(await defaultConfig());
    expect(config.image.reference).toMatch(/^ghcr\.io\/zharskiy\/pi-sandbox:\d+\.\d+\.\d+/);
    expect(config.credentials).toEqual({ kind: "host-pi-auth", rules: [], derive: { enabled: true } });
    expect(config.fallback).toBe("host");
    expect(config.ssh).toEqual({ agent: false });
    expect(sources["egress.allow"]).toBe("default");
    expect(sources["resources.cpus"]).toBeUndefined();
  });

  it("lets the lowest layer win for convenience keys and records the source per key", async () => {
    const { config, sources } = await loadWith({
      policy: { resources: { cpus: 2, memoryGiB: 4 }, mounts: { cacheVolumes: ["a"] } },
      user: { resources: { cpus: 6 }, mounts: { cacheVolumes: ["b"] } },
      project: { mounts: { cacheVolumes: ["node_modules"] } },
    });

    expect(config.resources).toEqual({ cpus: 6, memoryGiB: 4 });
    expect(config.mounts.cacheVolumes).toEqual(["node_modules"]);
    expect(sources).toMatchObject({
      "resources.cpus": "user",
      "resources.memoryGiB": "policy",
      "mounts.cacheVolumes": "project",
      backend: "default",
    });
  });

  it("adds env.allow entries from the policy and user layers", async () => {
    const { config, sources } = await loadWith({
      policy: { env: { allow: ["PAGER"] } },
      user: { env: { allow: ["EDITOR"] } },
    });

    expect(config.env.allow).toEqual(expect.arrayContaining(["TERM", "LANG", "EDITOR", "PAGER"]));
    expect(sources["env.allow"]).toBe("user");
  });

  it("refuses a project config that sets env.allow, image.reference or image.digest and names the file", async () => {
    const files = await createLayers();

    await files.project({ env: { allow: ["EDITOR"] } });

    const loading = loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });

    await expect(loading).rejects.toThrow(
      `project: env.allow may not be set by a project config (${files.projectFile})`,
    );

    await files.project({ image: { reference: "evil/pi" } });

    await expect(loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env })).rejects.toThrow(
      "project: image.reference may not be set by a project config",
    );

    await files.project({ image: { digest: `sha256:${"e".repeat(64)}` } });

    await expect(loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env })).rejects.toThrow(
      `project: image.digest may not be set by a project config (${files.projectFile})`,
    );
  });

  it("lets the user turn the ssh agent on unless policy keeps it off", async () => {
    const { config } = await loadWith({ user: { ssh: { agent: true } } });

    expect(config.ssh.agent).toBe(true);
    await expect(
      loadWith({ policy: { ssh: { agent: false } }, user: { ssh: { agent: true } } }),
    ).rejects.toThrow("user: ssh.agent cannot enable, locked by policy");
  });

  it("keeps the project from turning the ssh agent on, even when the user did", async () => {
    await expect(loadWith({ project: { ssh: { agent: true } } })).rejects.toThrow(
      "project: ssh.agent cannot enable, locked by the defaults",
    );
    await expect(
      loadWith({ user: { ssh: { agent: true } }, project: { ssh: { agent: true } } }),
    ).resolves.toMatchObject({ config: { ssh: { agent: true } } });

    const { config } = await loadWith({ user: { ssh: { agent: true } }, project: { ssh: { agent: false } } });

    expect(config.ssh.agent).toBe(false);
  });

  it("applies the profile chosen by a layer below the layers", async () => {
    const { config, sources } = await loadWith({ user: { profile: "team" } });

    expect(config.profile).toBe("team");
    expect(config.fallback).toBe("refuse");
    expect(config.credentials).toEqual({ kind: "static", rules: [], derive: { enabled: true } });
    expect(sources).toMatchObject({ profile: "user", fallback: "profile", credentials: "profile" });
  });

  it("lets lower layers tighten security keys", async () => {
    const { config, sources } = await loadWith({
      policy: { egress: { allow: ["github.com", "npmjs.org"] }, fallback: "host" },
      user: { egress: { allow: ["github.com"] }, fallback: "refuse" },
      project: { egress: { allow: [] }, workspaceRoots: { roots: ["/srv"], outside: "refuse" } },
    });

    expect(config.egress.allow).toEqual([]);
    expect(config.fallback).toBe("refuse");
    expect(config.workspaceRoots).toEqual({ roots: ["/srv"], outside: "refuse" });
    expect(sources).toMatchObject({ "egress.allow": "project", fallback: "user", workspaceRoots: "project" });
  });

  it("lets the user layer loosen the defaults and the backend when policy leaves them open", async () => {
    const { config } = await loadWith({
      user: {
        egress: { allow: ["github.com", "crates.io"] },
        credentials: { kind: "static", envVar: "API" },
      },
      project: { backend: "apple" },
    });

    expect(config.egress.allow).toEqual(["github.com", "crates.io"]);
    expect(config.credentials).toEqual({
      kind: "static",
      envVar: "API",
      rules: [],
      derive: { enabled: true },
    });
    expect(config.backend).toBe("apple");
  });

  const loosening: Array<[string, { policy?: unknown; user?: unknown; project?: unknown }, string]> = [
    [
      "egress.allow",
      {
        policy: { egress: { allow: ["github.com"] } },
        user: { egress: { allow: ["github.com", "evil.test"] } },
      },
      "user: egress.allow cannot add evil.test, locked by policy",
    ],
    [
      "egress.mcpHosts",
      {
        user: { egress: { mcpHosts: ["mcp.acme.test"] } },
        project: { egress: { mcpHosts: ["mcp.evil.test"] } },
      },
      "project: egress.mcpHosts cannot add mcp.evil.test, locked by user",
    ],
    [
      "credentials",
      {
        policy: { credentials: { kind: "sso", command: ["sso"] } },
        user: { credentials: { kind: "host-pi-auth" } },
      },
      "user: credentials cannot change, locked by policy",
    ],
    [
      "mounts.extraReadOnly",
      {
        policy: { mounts: { extraReadOnly: ["/opt/tools"] } },
        user: { mounts: { extraReadOnly: ["/etc"] } },
      },
      "user: mounts.extraReadOnly cannot add /etc, locked by policy",
    ],
    [
      "fallback",
      { policy: { fallback: "refuse" }, user: { fallback: "host" } },
      "user: fallback cannot become host, locked by policy",
    ],
    [
      "workspaceRoots.roots",
      {
        policy: { workspaceRoots: { roots: ["/srv/repos"], outside: "refuse" } },
        user: { workspaceRoots: { roots: ["/srv/repos/a", "/home"], outside: "refuse" } },
      },
      "user: workspaceRoots cannot add /home, locked by policy",
    ],
    [
      "workspaceRoots.outside",
      {
        policy: { workspaceRoots: { roots: ["/srv"], outside: "refuse" } },
        project: { workspaceRoots: { roots: ["/srv"], outside: "warn" } },
      },
      "project: workspaceRoots cannot relax outside to warn, locked by policy",
    ],
    [
      "image.digest",
      { policy: { image: { digest: DIGEST } }, user: { image: { digest: OTHER_DIGEST } } },
      "user: image.digest cannot change, locked by policy",
    ],
    [
      "image.reference",
      {
        policy: { image: { reference: "ghcr.io/acme/pi:1", digest: DIGEST } },
        user: { image: { reference: "evil/pi" } },
      },
      "user: image.reference cannot change, locked by policy",
    ],
    [
      "gateway",
      { policy: { gateway: GATEWAY }, user: { gateway: { ...GATEWAY, url: "https://evil.test" } } },
      "user: gateway cannot change, locked by policy",
    ],
    [
      "backend",
      { policy: { backend: "colima" }, project: { backend: "apple" } },
      "project: backend cannot change, locked by policy",
    ],
    [
      "profile",
      { policy: { profile: "enterprise" }, user: { profile: "solo" } },
      "user: profile cannot change, locked by policy",
    ],
  ];

  it.each(loosening)("refuses loosening %s and names the locking layer", async (_key, layers, message) => {
    await expect(loadWith(layers)).rejects.toThrow(message);
  });

  it("keeps the project layer from loosening the defaults or the profile", async () => {
    await expect(loadWith({ project: { egress: { allow: ["evil.test"] } } })).rejects.toThrow(
      "project: egress.allow cannot add evil.test, locked by the defaults",
    );
    await expect(loadWith({ project: { credentials: { kind: "static" } } })).rejects.toThrow(
      "project: credentials cannot change, locked by the defaults",
    );
    await expect(loadWith({ project: { gateway: GATEWAY } })).rejects.toThrow(
      "project: gateway cannot change, locked by the defaults",
    );
    await expect(loadWith({ project: { profile: "solo" } })).rejects.toThrow(
      "project: profile cannot change, locked by the defaults",
    );
    await expect(loadWith({ user: { profile: "team" }, project: { fallback: "host" } })).rejects.toThrow(
      "project: fallback cannot become host, locked by profile team",
    );
  });

  it("locks the profile values for the user when policy chose the profile", async () => {
    await expect(loadWith({ policy: { profile: "enterprise" }, user: { fallback: "host" } })).rejects.toThrow(
      "user: fallback cannot become host, locked by profile enterprise",
    );
  });

  it("names the layer and key of an invalid layer file", async () => {
    await expect(loadWith({ project: { resources: { cpus: "2" } } })).rejects.toThrow(
      "project: resources.cpus must be a number",
    );
    await expect(loadWith({ user: { ports: [3000] } })).rejects.toThrow("user: ports is not a known key");
    await expect(loadWith({ policy: { egress: { blocked: [] } } })).rejects.toThrow(
      "policy: egress.blocked is not a known key",
    );
    await expect(loadWith({ user: "{ not json" })).rejects.toThrow("invalid JSON");
  });
});

describe("mergeLayers", () => {
  it("merges in-memory layers without files", async () => {
    const { config, sources } = mergeLayers({
      defaults: await defaultConfig(),
      layers: { policy: { egress: { allow: ["github.com"] } }, project: { resources: { cpus: 2 } } },
    });

    expect(config.egress.allow).toEqual(["github.com"]);
    expect(config.resources.cpus).toBe(2);
    expect(sources).toMatchObject({ "egress.allow": "policy", "resources.cpus": "project" });
  });
});

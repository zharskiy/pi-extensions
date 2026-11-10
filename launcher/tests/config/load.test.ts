import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { egressAllowList, loadEffectiveConfig } from "../../config/index.ts";
import { launcherRoot } from "../../shared/index.ts";
import { createLayers } from "./fixtures.ts";

interface Layers {
  baseline?: unknown;
  policy?: (orgFile: string) => unknown;
  user?: (orgFile: string) => unknown;
  project?: unknown;
}

const loadWith = async (layers: Layers) => {
  const files = await createLayers();
  const orgFile = join(files.repoRoot, "..", "org.json");

  if (layers.baseline !== undefined) {
    await writeFile(orgFile, JSON.stringify(layers.baseline));
  }

  if (layers.policy !== undefined) {
    await files.policy(layers.policy(orgFile));
  }

  if (layers.user !== undefined) {
    await files.user(layers.user(orgFile));
  }

  if (layers.project !== undefined) {
    await files.project(layers.project);
  }

  return loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });
};

const ignoredWith = async (layers: Layers) =>
  (await loadWith(layers)).ignored.map((entry) => `${entry.layer}: ${entry.key} (${entry.reason})`);

describe("loadEffectiveConfig", () => {
  it("returns the defaults when no layer file exists", async () => {
    const { config, sources } = await loadWith({});

    expect(config).toEqual(await defaultConfig());
    expect(config.image.reference).toMatch(/^ghcr\.io\/zharskiy\/pi-sandbox:\d+\.\d+\.\d+/);
    expect(config.credentials).toEqual({ rules: [], derive: { enabled: true } });
    expect(config.egress.grants).toBe(true);
    expect(sources["egress.allow"]).toBe("default");
    expect(sources["resources.cpus"]).toBeUndefined();
  });

  it("allows the npm, pypi and github registry hosts by default through egress.presets", async () => {
    const { config, sources } = await loadWith({});

    expect(config.egress.allow).toEqual([]);
    expect(sources["egress.presets"]).toBe("default");
    expect(egressAllowList(config.egress)).toEqual([
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "repo.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  it("expands the user's presets ahead of egress.allow without duplicates", async () => {
    const { config } = await loadWith({
      user: () => ({ egress: { presets: ["maven", "go"], allow: ["repo1.maven.org", "corp.test"] } }),
    });

    expect(egressAllowList(config.egress)).toEqual([
      "repo.maven.apache.org",
      "repo1.maven.org",
      "proxy.golang.org",
      "sum.golang.org",
      "corp.test",
    ]);
  });

  it("lets Gradle plugins resolve through the gradle preset, artifact host included", async () => {
    const { config } = await loadWith({ user: () => ({ egress: { presets: ["gradle"] } }) });

    expect(egressAllowList(config.egress)).toEqual([
      "plugins.gradle.org",
      "plugins-artifacts.gradle.org",
      "services.gradle.org",
      "downloads.gradle.org",
    ]);
  });

  it("lets the policy turn the presets off for good", async () => {
    const { config } = await loadWith({ policy: () => ({ egress: { presets: [] } }) });

    expect(egressAllowList(config.egress)).toEqual([]);
    const kept = await loadWith({
      policy: () => ({ egress: { presets: [] } }),
      user: () => ({ egress: { presets: ["npm"] } }),
    });

    expect(egressAllowList(kept.config.egress)).toEqual([]);
    expect(kept.ignored).toEqual([
      { layer: "user", key: "egress.presets", reason: "final in the policy config" },
    ]);
  });

  it("refuses to forward JAVA_TOOL_OPTIONS, which carries the sandbox proxy", async () => {
    await expect(loadWith({ user: () => ({ env: { allow: ["JAVA_TOOL_OPTIONS"] } }) })).rejects.toThrow(
      "user: env.allow[0] JAVA_TOOL_OPTIONS is set by the launcher and is not forwarded",
    );
  });

  it("refuses an unknown preset", async () => {
    await expect(loadWith({ user: () => ({ egress: { presets: ["apt"] } }) })).rejects.toThrow(
      "egress.presets[0]",
    );
  });

  it("lets the lowest layer win for keys no admin layer set and records the source per key", async () => {
    const { config, sources } = await loadWith({
      user: () => ({ resources: { cpus: 6, memoryGiB: 4 }, egress: { allow: ["crates.io"] } }),
      project: { resources: { cpus: 2 }, mounts: { cacheVolumes: ["node_modules"] } },
    });

    expect(config.resources).toEqual({ cpus: 2, memoryGiB: 4 });
    expect(config.egress.allow).toEqual(["crates.io"]);
    expect(config.mounts.cacheVolumes).toEqual(["node_modules"]);
    expect(sources).toMatchObject({
      "resources.cpus": "project",
      "resources.memoryGiB": "user",
      "egress.allow": "user",
      "mounts.cacheVolumes": "project",
    });
  });

  it("adds egress.deny and env.allow entries from every layer", async () => {
    const { config } = await loadWith({
      policy: () => ({ env: { allow: ["PAGER"] }, egress: { deny: ["paste.example.test"] } }),
      user: () => ({ env: { allow: ["EDITOR"] }, egress: { deny: ["bin.example.test"] } }),
    });

    expect(config.env.allow).toEqual(expect.arrayContaining(["TERM", "LANG", "EDITOR", "PAGER"]));
    expect(config.egress.deny).toEqual(["paste.example.test", "bin.example.test"]);
  });

  it("ignores a lower layer's key the policy set, and names both layers", async () => {
    const ignored = await loadWith({
      policy: () => ({ fallback: "refuse", resources: { cpus: 2 } }),
      user: () => ({ fallback: "host" }),
      project: { resources: { cpus: 4 } },
    });

    expect(ignored.config.fallback).toBe("refuse");
    expect(ignored.config.resources.cpus).toBe(2);
    expect(ignored.ignored.map((entry) => `${entry.layer}: ${entry.key} (${entry.reason})`)).toEqual([
      "user: fallback (final in the policy config)",
      "project: resources.cpus (final in the policy config)",
    ]);
  });

  it("ignores every project key outside its allowlist, names the file and keeps the allowed keys", async () => {
    const { config, ignored } = await loadWith({
      project: {
        egress: { allow: ["evil.test"], privateHosts: ["evil.test"] },
        credentials: { rules: [] },
        image: { packages: ["curl"] },
        resources: { cpus: 2 },
      },
    });

    expect(config.egress.allow).toEqual([]);
    expect(config.egress.privateHosts).toEqual([]);
    expect(config.image.packages).toBeUndefined();
    expect(config.resources.cpus).toBe(2);
    expect(ignored.map((entry) => entry.key)).toEqual([
      "egress.allow",
      "egress.privateHosts",
      "credentials.rules",
      "image.packages",
    ]);
    expect(ignored[0]?.reason).toMatch(
      /^a project config may set only mounts\.cacheVolumes, mounts\.autoOverlays, resources\.cpus, resources\.memoryGiB; \/.*\.pi\/sandbox\.json$/,
    );
  });

  it("names the layer and key of an invalid layer file", async () => {
    await expect(loadWith({ project: { resources: { cpus: "2" } } })).rejects.toThrow(
      "project: resources.cpus must be a number",
    );
    await expect(loadWith({ user: () => ({ ports: [3000] }) })).rejects.toThrow(
      "user: ports is not a known key",
    );
    await expect(loadWith({ policy: () => ({ egress: { blocked: [] } }) })).rejects.toThrow(
      "policy: egress.blocked is not a known key",
    );
    await expect(loadWith({ user: () => "{ not json" })).rejects.toThrow("invalid JSON");
  });
});

describe("loadEffectiveConfig with a project file that is not a regular file", () => {
  const loadWithProject = async (place: (file: string) => Promise<unknown>) => {
    const files = await createLayers();

    await mkdir(join(files.repoRoot, ".pi"), { recursive: true });

    await place(files.projectFile);

    return loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });
  };

  it("refuses a FIFO without opening it", async () => {
    await expect(loadWithProject((file) => promisify(execFile)("/usr/bin/mkfifo", [file]))).rejects.toThrow(
      /^project: .*\.pi\/sandbox\.json is not a regular file$/,
    );
  });

  it("refuses a symlink, even to a device or a valid file", async () => {
    await expect(loadWithProject((file) => symlink("/dev/zero", file))).rejects.toThrow(
      "is not a regular file",
    );
    await expect(
      loadWithProject(async (file) => {
        await writeFile(`${file}.real`, JSON.stringify({ resources: { cpus: 2 } }));

        await symlink(`${file}.real`, file);
      }),
    ).rejects.toThrow("is not a regular file");
  });

  it("refuses a file larger than the read cap", async () => {
    await expect(
      loadWithProject((file) => writeFile(file, `{"resources":{"cpus":2}}${" ".repeat(9 * 1024 * 1024)}`)),
    ).rejects.toThrow(/^project: .* is larger than \d+ bytes$/);
  });

  it("reads a regular file and names the file of invalid JSON", async () => {
    const { config } = await loadWithProject((file) =>
      writeFile(file, JSON.stringify({ resources: { cpus: 2 } })),
    );

    expect(config.resources.cpus).toBe(2);
    await expect(loadWithProject((file) => writeFile(file, "{ not json"))).rejects.toThrow("invalid JSON");
  });
});

describe("loadEffectiveConfig with an org baseline", () => {
  it("applies the org file between policy and user and makes its keys final", async () => {
    const { config, sources } = await loadWith({
      baseline: { fallback: "refuse", egress: { allow: ["github.com"] } },
      policy: (org) => ({ org, resources: { memoryGiB: 8 } }),
      user: () => ({ resources: { cpus: 4 } }),
    });

    expect(config.fallback).toBe("refuse");
    expect(config.egress.allow).toEqual(["github.com"]);
    expect(sources).toMatchObject({ fallback: "org", "egress.allow": "org", "resources.cpus": "user" });
  });

  it("loads the org named by the user when policy names none", async () => {
    await expect(
      loadWith({ baseline: { fallback: "refuse" }, user: (org) => ({ org }) }),
    ).resolves.toMatchObject({ config: { fallback: "refuse" }, sources: { fallback: "org" } });
  });

  it("ignores a user key the org baseline set", async () => {
    expect(
      await ignoredWith({
        baseline: { egress: { grants: false } },
        user: (org) => ({ org, egress: { grants: true } }),
      }),
    ).toEqual(["user: egress.grants (final in the org config)"]);
  });

  it("ignores an org baseline key the policy set", async () => {
    expect(
      await ignoredWith({ baseline: { fallback: "host" }, policy: (org) => ({ org, fallback: "refuse" }) }),
    ).toEqual(["org: fallback (final in the policy config)"]);
  });

  it("ignores a user org when policy names one", async () => {
    expect(await ignoredWith({ baseline: {}, policy: (org) => ({ org }), user: (org) => ({ org }) })).toEqual(
      ["user: org (final in the policy config)"],
    );
  });

  it("merges the README's Java user config over the example org baseline", async () => {
    const baseline = JSON.parse(
      await readFile(join(launcherRoot(), "examples", "org-baseline.json"), "utf8"),
    ) as { egress: { allow: string[] } };
    const { config, ignored } = await loadWith({
      baseline,
      user: (org) => ({
        org,
        egress: { presets: ["npm", "pypi", "github", "maven", "gradle"], allow: ["registry.corp.example"] },
        mounts: { hostCaches: ["maven", "gradle"] },
        image: { packages: ["openjdk-17-jdk-headless", "maven"] },
      }),
    });

    expect(ignored).toEqual([]);
    expect(config.egress.allow).toEqual([...baseline.egress.allow, "registry.corp.example"]);
    expect(config.image.packages).toEqual(["openjdk-17-jdk-headless", "maven"]);
    expect(config.credentials.derive.enabled).toBe(true);
    expect(config.egress.grants).toBe(false);
  });

  it("names a missing org file and refuses an org that is not an absolute path", async () => {
    await expect(loadWith({ user: (org) => ({ org }) })).rejects.toThrow(/^org: .*org\.json does not exist$/);
    await expect(loadWith({ user: () => ({ org: "https://config.example.test/org.json" }) })).rejects.toThrow(
      "user: org must be an absolute path",
    );
  });

  it("keeps the project and the org baseline from setting org", async () => {
    expect(await ignoredWith({ project: { org: "/etc/org.json" } })).toEqual([
      expect.stringMatching(/^project: org \(a project config may set only /),
    ]);
    await expect(
      loadWith({ baseline: { org: "/etc/other.json" }, user: (org) => ({ org }) }),
    ).rejects.toThrow("org: org may only be set by the policy or user config");
  });
});

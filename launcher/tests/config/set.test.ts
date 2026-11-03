import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEffectiveConfig, setConfigValue } from "../../config/index.ts";
import { createLayers } from "./fixtures.ts";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("setConfigValue", () => {
  it("writes a user value and keeps the other keys", async () => {
    const files = await createLayers();

    await files.user({ mounts: { cacheVolumes: ["node_modules"] } });

    const result = await setConfigValue({ layer: "user", key: "resources.cpus", value: 4, env: files.env });

    expect(result.file).toBe(files.userFile);
    expect(await readJson(files.userFile)).toEqual({
      mounts: { cacheVolumes: ["node_modules"] },
      resources: { cpus: 4 },
    });
  });

  it("creates the user file when missing", async () => {
    const files = await createLayers();

    await setConfigValue({
      layer: "user",
      key: "egress.allow",
      value: ["github.com", "crates.io"],
      env: files.env,
    });

    const { config, sources } = await loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });

    expect(config.egress.allow).toEqual(["github.com", "crates.io"]);
    expect(sources["egress.allow"]).toBe("user");
  });

  it("creates .pi with a .gitignore when the project has none", async () => {
    const files = await createLayers();

    await setConfigValue({
      layer: "project",
      key: "mounts.cacheVolumes",
      value: ["node_modules"],
      repoRoot: files.repoRoot,
      env: files.env,
    });

    expect(await readJson(files.projectFile)).toEqual({ mounts: { cacheVolumes: ["node_modules"] } });
    expect(await readFile(join(files.repoRoot, ".pi", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("leaves an existing .pi folder and its .gitignore alone", async () => {
    const files = await createLayers();
    const gitignore = join(files.repoRoot, ".pi", ".gitignore");

    await mkdir(join(files.repoRoot, ".pi"));

    await setConfigValue({
      layer: "project",
      key: "resources.cpus",
      value: 1,
      repoRoot: files.repoRoot,
      env: files.env,
    });

    expect(await exists(gitignore)).toBe(false);

    await writeFile(gitignore, "worktrees/\n");

    await setConfigValue({
      layer: "project",
      key: "resources.cpus",
      value: 2,
      repoRoot: files.repoRoot,
      env: files.env,
    });

    expect(await readFile(gitignore, "utf8")).toBe("worktrees/\n");
    expect(await readJson(files.projectFile)).toEqual({ resources: { cpus: 2 } });
  });

  it("refuses loosening a locked security key and leaves the file unchanged", async () => {
    const files = await createLayers();

    await files.policy({ egress: { allow: ["github.com"] } });
    await files.user({ resources: { cpus: 1 } });

    await expect(
      setConfigValue({
        layer: "user",
        key: "egress.allow",
        value: ["github.com", "evil.test"],
        env: files.env,
      }),
    ).rejects.toThrow("user: egress.allow cannot add evil.test, locked by policy");
    expect(await readJson(files.userFile)).toEqual({ resources: { cpus: 1 } });
  });

  it("refuses a project value that loosens the user layer without writing .pi", async () => {
    const files = await createLayers();

    await files.user({ fallback: "refuse" });

    await expect(
      setConfigValue({
        layer: "project",
        key: "fallback",
        value: "host",
        repoRoot: files.repoRoot,
        env: files.env,
      }),
    ).rejects.toThrow("project: fallback cannot become host, locked by user");
    expect(await exists(join(files.repoRoot, ".pi"))).toBe(false);
  });

  it("refuses unknown keys, invalid values and a project write without a repository", async () => {
    const files = await createLayers();

    await expect(
      setConfigValue({ layer: "user", key: "egress.deny", value: [], env: files.env }),
    ).rejects.toThrow("user: egress.deny is not a known key");
    await expect(
      setConfigValue({ layer: "user", key: "egress.allow", value: "80", env: files.env }),
    ).rejects.toThrow("user: egress.allow must be an array");
    await expect(
      setConfigValue({ layer: "user", key: "env.allow", value: ["NPM_TOKEN"], env: files.env }),
    ).rejects.toThrow("looks like a secret");
    await expect(
      setConfigValue({ layer: "project", key: "resources.cpus", value: 1, env: files.env }),
    ).rejects.toThrow("project: no repository root");
    await expect(
      setConfigValue({
        layer: "project",
        key: "env.allow",
        value: ["EDITOR"],
        repoRoot: files.repoRoot,
        env: files.env,
      }),
    ).rejects.toThrow("project: env.allow may not be set by a project config");
    expect(await exists(join(files.repoRoot, ".pi"))).toBe(false);
  });
});

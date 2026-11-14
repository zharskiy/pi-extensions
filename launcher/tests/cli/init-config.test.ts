import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { writeNewFile } from "../../shared/index.ts";
import { createHarness } from "./harness.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("pi-sandbox __init-config", () => {
  it("writes the roots to an absent config, keeping ~ roots and resolving relative ones", async () => {
    const harness = await createHarness();

    expect(await run(["__init-config", "~/work", harness.repoRoot, "lib"], harness.deps)).toBe(0);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(
      `${JSON.stringify({ workspaceRoots: { roots: ["~/work", harness.repoRoot, join(harness.cwd, "lib")] } }, null, 2)}\n`,
    );
    expect((await stat(harness.userConfigFile)).mode & 0o777).toBe(0o600);
  });

  it("leaves a config that already holds the same roots alone", async () => {
    const harness = await createHarness();
    const config = { workspaceRoots: { roots: [harness.repoRoot] }, env: { allow: ["FOO"] } };

    await harness.writeJson(harness.userConfigFile, config);

    expect(await run(["__init-config", harness.repoRoot], harness.deps)).toBe(0);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify(config));
  });

  it("takes the same roots written another way as a match", async () => {
    const harness = await createHarness();
    const config = { workspaceRoots: { roots: [`${harness.repoRoot}/`, "~/work"] } };

    await mkdir(join(harness.deps.home, "work"), { recursive: true });

    await harness.writeJson(harness.userConfigFile, config);

    expect(
      await run(["__init-config", join(harness.deps.home, "work"), harness.repoRoot], harness.deps),
    ).toBe(0);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify(config));
  });

  it("refuses a config without workspaceRoots and leaves it as it is", async () => {
    const harness = await createHarness();
    const config = { env: { allow: ["FOO"] } };

    await harness.writeJson(harness.userConfigFile, config);

    expect(await run(["__init-config", harness.repoRoot], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`${harness.userConfigFile} exists; set workspaceRoots in it`);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify(config));
  });

  it("never replaces a config that appears while it writes", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, {});

    expect(await writeNewFile(harness.userConfigFile, "{}\n")).toBe(false);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe("{}");
    expect(await writeNewFile(join(harness.root, "fresh.json"), "{}\n")).toBe(true);
  });

  it("refuses a config with other roots and writes nothing", async () => {
    const harness = await createHarness();
    const config = { workspaceRoots: { roots: ["~/elsewhere"] } };

    await harness.writeJson(harness.userConfigFile, config);

    expect(await run(["__init-config", harness.repoRoot], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(
      `pi-sandbox: ${harness.userConfigFile} exists; set workspaceRoots in it, or install without --root\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify(config));
  });

  it("refuses a root workspaceRoots refuses with its config message and writes nothing", async () => {
    const harness = await createHarness();

    expect(await run(["__init-config", harness.repoRoot, "~/.ssh"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("pi-sandbox: config: workspaceRoots.roots: ~/.ssh overlaps ~/.ssh");
    expect(harness.stderr()).toContain("hint: name the project folders themselves in workspaceRoots.roots");
    expect(await exists(harness.userConfigFile)).toBe(false);
  });

  it("refuses a call without roots", async () => {
    const harness = await createHarness();

    expect(await run(["__init-config"], harness.deps)).toBe(1);
    expect(await exists(harness.userConfigFile)).toBe(false);
  });
});

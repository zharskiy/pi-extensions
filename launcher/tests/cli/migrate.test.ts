import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { nodeModulesOverlays, repoVolumes } from "../../container/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { createHarness } from "./harness.ts";

const archivingBackend = (
  name: Backend["name"],
  contents: Map<string, string>,
  registry: Record<string, string> = {},
) => {
  const fake = createFakeBackend({ registry });
  const helperImages: string[] = [];
  const backend: Backend = {
    ...fake.backend,
    name,
    exportVolume: async (volume, tarPath, imageId) => {
      helperImages.push(imageId);

      await writeFile(tarPath, contents.get(volume) ?? "");
    },
    importVolume: async (volume, tarPath, imageId) => {
      helperImages.push(imageId);

      contents.set(volume, await readFile(tarPath, "utf8"));
    },
  };

  return { fake, backend, contents, helperImages };
};

const PINNED_REFERENCE = "example.test/pi-sandbox:1";

const PINNED_DIGEST = `sha256:${"f".repeat(64)}`;

describe("pi sandbox migrate", () => {
  it("moves the agent and cache volumes to the target, sets the user backend and removes the old container", async () => {
    const source = archivingBackend("colima", new Map());
    const target = archivingBackend("apple", new Map());
    const harness = await createHarness({ adapters: () => [source.backend, target.backend] });

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["node_modules"] } });

    await run([], harness.deps);

    const [agent = "", cache = ""] = repoVolumes({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } }),
      hostEnv: harness.deps.env,
      uid: harness.deps.uid,
    });

    source.contents.set(agent, "sessions and trust");

    source.contents.set(cache, "cached packages");

    expect(source.fake.containers.size).toBe(1);
    expect(await run(["sandbox", "migrate", "--to", "apple"], harness.deps)).toBe(0);
    expect(target.contents.get(agent)).toBe("sessions and trust");
    expect(target.contents.get(cache)).toBe("cached packages");
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      mounts: { cacheVolumes: ["node_modules"] },
      backend: "apple",
    });
    expect(source.fake.containers.size).toBe(0);
    expect(harness.stdout()).toContain(`${harness.stateDir}/migrate/1700000000000/${agent}.tar`);
  });

  it("moves the node_modules overlay volume of a node project", async () => {
    const source = archivingBackend("colima", new Map());
    const target = archivingBackend("apple", new Map());
    const harness = await createHarness({ adapters: () => [source.backend, target.backend] });

    await writeFile(join(harness.repoRoot, "package-lock.json"), "{}");

    await run([], harness.deps);

    const [overlay] = nodeModulesOverlays(
      {
        cwd: harness.repoRoot,
        repoRoot: harness.repoRoot,
        isGitRepo: true,
        nodeProjects: [harness.repoRoot],
      },
      sandboxConfig(),
    );
    const name = overlay?.name ?? "";

    source.contents.set(name, "installed packages");

    expect(source.fake.volumes.has(name)).toBe(true);
    expect(await run(["sandbox", "migrate", "--to", "apple"], harness.deps)).toBe(0);
    expect(target.contents.get(name)).toBe("installed packages");
    expect(harness.stdout()).toContain(`${harness.stateDir}/migrate/1700000000000/${name}.tar`);
  });

  it("moves volumes with a pinned digest through each backend's own image id, never the reference tag", async () => {
    const registry = { [PINNED_REFERENCE]: PINNED_DIGEST };
    const source = archivingBackend("colima", new Map(), registry);
    const target = archivingBackend("apple", new Map(), registry);
    const harness = await createHarness({ adapters: () => [source.backend, target.backend] });

    await harness.writeJson(harness.userConfigFile, {
      image: { reference: PINNED_REFERENCE, digest: PINNED_DIGEST },
    });

    await run([], harness.deps);

    const sourceImage = (await source.backend.resolveImage(PINNED_REFERENCE))?.id;

    expect(await run(["sandbox", "migrate", "--to", "apple"], harness.deps)).toBe(0);

    const targetImage = (await target.backend.resolveImage(PINNED_REFERENCE))?.id;

    expect(sourceImage).toMatch(/^sha256:image-/);
    expect(target.fake.pulls).toEqual([PINNED_REFERENCE]);
    expect(source.helperImages).toEqual([sourceImage]);
    expect(target.helperImages).toEqual([targetImage]);
    expect([...source.helperImages, ...target.helperImages]).not.toContain(PINNED_REFERENCE);
  });

  it("refuses an unknown target, the current backend and an unavailable target", async () => {
    const source = archivingBackend("colima", new Map());
    const target = archivingBackend("apple", new Map());
    const downTarget = {
      ...target.backend,
      detect: async () => ({ available: false, reason: "not installed" }),
    };
    const harness = await createHarness({ adapters: () => [source.backend, downTarget] });

    expect(await run(["sandbox", "migrate", "--to", "vmware"], harness.deps)).toBe(1);
    expect(await run(["sandbox", "migrate", "--to", "colima"], harness.deps)).toBe(1);
    expect(await run(["sandbox", "migrate", "--to", "apple"], harness.deps)).toBe(1);

    expect(harness.stderr().split("\n")).toEqual([
      "pi-sandbox: usage: pi sandbox migrate --to <colima|apple>",
      "pi-sandbox: migrate: already on colima",
      "pi-sandbox: migrate: apple is not available: not installed",
      "",
    ]);
  });
});

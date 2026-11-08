import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS, nodeModulesOverlays, sharedCacheVolumes } from "../../container/index.ts";
import { registerSession } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { createHarness } from "./harness.ts";

const SHARED = "~/.cache/pip";

const volumeHarness = async () => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend });
  const config = sandboxConfig({ mounts: { sharedCaches: [SHARED] } });

  await writeFile(join(harness.repoRoot, "package-lock.json"), "{}");

  await harness.writeJson(harness.userConfigFile, { mounts: { sharedCaches: [SHARED] } });

  const [shared] = sharedCacheVolumes(config, harness.stateDir);
  const [overlay] = nodeModulesOverlays(
    { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true, nodeProjects: [harness.repoRoot] },
    config,
  );

  return { fake, harness, shared: shared?.name ?? "", overlay: overlay?.name ?? "" };
};

const plantShared = (fake: ReturnType<typeof createFakeBackend>, name: string, userHash: string) =>
  fake.backend.ensureVolume(name, { [LABELS.userHash]: userHash, [LABELS.sharedPath]: SHARED });

describe("pi sandbox gc and shared caches", () => {
  it("keeps every shared cache without --shared-caches and never counts them as unlabelled", async () => {
    const { fake, harness, shared } = await volumeHarness();

    await run([], harness.deps);

    await plantShared(fake, "pi-sandbox-shared-otheruser000-aaaaaaaa", "otheruser000");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.volumes.has(shared)).toBe(true);
    expect(fake.volumes.has("pi-sandbox-shared-otheruser000-aaaaaaaa")).toBe(true);
    expect(harness.stdout()).not.toContain("without repository label");
    expect(harness.stdout()).not.toContain("shared cache");
  });

  it("removes only this user's unused shared caches with --shared-caches", async () => {
    const { fake, harness, shared } = await volumeHarness();

    await run([], harness.deps);

    await plantShared(fake, "pi-sandbox-shared-otheruser000-aaaaaaaa", "otheruser000");

    expect(await run(["sandbox", "gc", "--shared-caches"], harness.deps)).toBe(0);
    expect(fake.volumes.has(shared)).toBe(false);
    expect(fake.volumes.has("pi-sandbox-shared-otheruser000-aaaaaaaa")).toBe(true);
    expect(harness.stdout()).toContain(`removed shared cache ${shared} (${SHARED})\n`);
    expect(harness.stdout()).not.toContain("without repository label");
  });

  it("keeps a shared cache a live sandbox still mounts and says so", async () => {
    const { fake, harness, shared } = await volumeHarness();

    await run([], harness.deps);

    await registerSession(harness.stateDir, {
      sessionId: "00000000000000cc",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    expect(await run(["sandbox", "gc", "--shared-caches"], harness.deps)).toBe(0);
    expect(fake.volumes.has(shared)).toBe(true);
    expect(harness.stdout()).toContain(`kept shared cache ${shared} (${SHARED}), in use\n`);
  });
});

describe("pi sandbox reset --volumes", () => {
  it("removes the node_modules overlays, those of deleted packages included, and keeps shared caches", async () => {
    const { fake, harness, shared, overlay } = await volumeHarness();
    const stale = `pi-sandbox-cache-${sha256Hex(harness.repoRoot).slice(0, 12)}-deadbeef`;

    await run([], harness.deps);

    await fake.backend.ensureVolume(stale, {
      [LABELS.repoHash]: sha256Hex(harness.repoRoot),
      [LABELS.repoRoot]: harness.repoRoot,
    });

    expect(fake.volumes.has(overlay)).toBe(true);
    expect(await run(["sandbox", "reset", "--volumes"], harness.deps)).toBe(0);
    expect(fake.volumes.has(overlay)).toBe(false);
    expect(fake.volumes.has(stale)).toBe(false);
    expect(fake.volumes.has(shared)).toBe(true);
    expect(harness.stdout()).toContain(`removed volume ${overlay}\n`);
    expect(harness.stdout()).toContain(`removed volume ${stale}\n`);
    expect(harness.stdout()).not.toContain(shared);
  });
});

describe("pi sandbox status and volumes", () => {
  it("lists the node_modules overlays and shared caches of this repository", async () => {
    const { harness, shared, overlay } = await volumeHarness();

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("node_modules overlays: 1");
    expect(lines).toContain(`node_modules overlay: ${join(harness.repoRoot, "node_modules")} (${overlay})`);
    expect(lines).toContain("shared caches: 1");
    expect(lines).toContain(`shared cache: ${SHARED} (${shared})`);
  });

  it("reports none of either when nothing is configured or found", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("node_modules overlays: 0");
    expect(lines).toContain("shared caches: 0");
    expect(lines.some((line) => line.startsWith("node_modules overlay:"))).toBe(false);
    expect(lines.some((line) => line.startsWith("shared cache:"))).toBe(false);
  });
});

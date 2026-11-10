import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { overlayVolumes, sharedCacheVolumes } from "../../container/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { createFakeBackend, createHarness, holdLaunch } from "./harness.ts";

const SHARED = "~/.cache/pip";

const volumeHarness = async () => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend });
  const config = sandboxConfig({ mounts: { sharedCaches: [SHARED] } });

  await writeFile(join(harness.repoRoot, "package-lock.json"), "{}");

  await harness.writeJson(harness.userConfigFile, { mounts: { sharedCaches: [SHARED] } });

  const [shared] = sharedCacheVolumes(config, harness.stateDir);
  const [overlay] = overlayVolumes(
    {
      cwd: harness.repoRoot,
      repoRoot: harness.repoRoot,
      isGitRepo: true,
      overlays: [join(harness.repoRoot, "node_modules")],
    },
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

    await holdLaunch(harness);

    await run([], harness.deps);

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

  it("removes an agent volume of this repository under an older name, and leaves other repositories' volumes", async () => {
    const { fake, harness } = await volumeHarness();
    const short = sha256Hex(harness.repoRoot).slice(0, 12);
    const orphan = `pi-sandbox-agent-0123456789ab-${short}`;
    const foreign = "pi-sandbox-agent-0123456789ab-ffffffffffff";

    await fake.backend.ensureVolume(orphan, {
      [LABELS.repoHash]: sha256Hex(harness.repoRoot),
      [LABELS.repoRoot]: harness.repoRoot,
    });

    await fake.backend.ensureVolume(foreign, {
      [LABELS.repoHash]: "f".repeat(64),
      [LABELS.repoRoot]: "/elsewhere",
    });

    expect(await run(["sandbox", "reset", "--volumes"], harness.deps)).toBe(0);
    expect(fake.volumes.has(orphan)).toBe(false);
    expect(fake.volumes.has(foreign)).toBe(true);
    expect(harness.stdout()).toContain(`removed volume ${orphan}\n`);
  });
});

describe("pi sandbox status and volumes", () => {
  it("lists the node_modules overlays and shared caches of this repository", async () => {
    const { harness, shared, overlay } = await volumeHarness();

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("overlays: 1");
    expect(lines).toContain(`overlay: ${join(harness.repoRoot, "node_modules")} (${overlay})`);
    expect(lines).toContain("shared caches: 1");
    expect(lines).toContain(`shared cache: ${SHARED} (${shared})`);
  });

  it("reports none of either when nothing is configured or found", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("overlays: 0");
    expect(lines).toContain("shared caches: 0");
    expect(lines.some((line) => line.startsWith("overlay:"))).toBe(false);
    expect(lines.some((line) => line.startsWith("shared cache:"))).toBe(false);
  });
});

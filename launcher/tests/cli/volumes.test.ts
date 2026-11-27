import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, runPinata } from "../../cli/index.ts";
import { configVolumeName, mountedVolumes } from "../../container/index.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, sweepNow } from "./harness.ts";

const SHARED = "~/.cache/pip";

const DATA = "/opt/data";

const volumeHarness = async () => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend });
  const volumes = [SHARED, { target: DATA }];
  const config = sandboxConfig({ mounts: { volumes } });

  await writeFile(join(harness.repoRoot, "package-lock.json"), "{}");

  await harness.writeJson(harness.userConfigFile, { mounts: { volumes } });

  const [shared, data] = mountedVolumes(config, harness.stateDir);

  return { fake, harness, shared: shared?.name ?? "", data: data?.name ?? "" };
};

const plantShared = (fake: ReturnType<typeof createFakeBackend>, name: string, install: string) =>
  fake.backendFor(install).ensureVolume(name, {});

describe("the sweep and configured volumes", () => {
  it("keeps every configured volume and never counts them as unlabelled", async () => {
    const { fake, harness, shared } = await volumeHarness();

    await run([], harness.deps);

    await plantShared(fake, "pinata-shared-otheruser000-aaaaaaaa", "otheruser000");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has(shared)).toBe(true);
    expect(fake.volumes.has("pinata-shared-otheruser000-aaaaaaaa")).toBe(true);
    expect(harness.stdout()).not.toContain("without repository label");
    expect(harness.stdout()).not.toContain("shared cache");
  });

  it("keeps a configured volume once a folder that mounted it is gone", async () => {
    const { fake, harness, data } = await volumeHarness();
    const gone = await tempDir("gone-volume-repo");
    const volume = configVolumeName(harness.stateDir, DATA);

    await harness.writeJson(stateLayout(harness.stateDir).repo(sha256Hex(gone)).record, { root: gone });

    await fake.backend.ensureVolume(volume, {});

    await rm(gone, { recursive: true, force: true });

    await sweepNow(harness.deps);

    expect(volume).toBe(data);
    expect(fake.volumes.has(data)).toBe(true);
  });
});

describe("pinata status and volumes", () => {
  it("lists the configured volumes and no overlay, also beside a lockfile", async () => {
    const { harness, shared, data } = await volumeHarness();

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(harness.stdout()).not.toContain("Overlays");
    expect(lines.filter((line) => /^ {2}(Volumes:| ) /.test(line))).toEqual([
      `  Volumes:     /home/pi/.cache/pip (${shared})`,
      `               ${DATA} (${data})`,
    ]);
  });

  it("reports no volumes when nothing is configured", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines.filter((line) => /^ {2}Volumes:/.test(line))).toEqual([]);
  });
});

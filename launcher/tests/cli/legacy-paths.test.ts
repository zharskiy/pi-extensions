import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness, unreachable } from "./harness.ts";

const legacyConfig = (home: string) => join(home, ".config", "pi-sandbox", "config.json");

const legacyState = (home: string) => join(home, ".local", "state", "pi-sandbox");

const writeLegacyConfig = async (home: string) => {
  await mkdir(join(home, ".config", "pi-sandbox"), { recursive: true });

  await writeFile(legacyConfig(home), "{}");
};

const doctorLines = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  await run(["sandbox", "doctor"], harness.deps);

  return harness.stdout().split("\n");
};

describe("the old config and state folders", () => {
  it("says at launch that the old user config is no longer read while the new one is missing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await writeLegacyConfig(harness.deps.home);

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${legacyConfig(harness.deps.home)} is no longer read; move it to ${harness.userConfigFile}\n`,
    );
  });

  it("stays quiet once the new user config exists", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await writeLegacyConfig(harness.deps.home);

    await harness.writeJson(harness.userConfigFile, {});

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("is no longer read");
  });

  it("warns in the doctor about the old user config and the old state folder", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    await writeLegacyConfig(harness.deps.home);

    await mkdir(join(legacyState(harness.deps.home), "ca"), { recursive: true });

    const lines = await doctorLines(harness);

    expect(lines).toContain(
      `warn user config: ${legacyConfig(harness.deps.home)} is no longer read; move it to ${harness.userConfigFile}`,
    );
    expect(lines).toContain(
      `warn old state: ${legacyState(harness.deps.home)} is no longer used, the launcher keeps its state in ${harness.stateDir}; delete it once no pi session started before the move runs`,
    );
  });

  it("prints no old-folder line in the doctor when neither old folder exists", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const lines = await doctorLines(harness);

    expect(lines.filter((line) => / (user config|old state): /.test(line))).toEqual([]);
  });
});

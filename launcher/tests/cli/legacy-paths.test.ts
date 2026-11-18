import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness, doctorReport, unreachable } from "./harness.ts";

const legacyConfig = (home: string) => join(home, ".config", "pi-sandbox", "config.json");

const legacyState = (home: string) => join(home, ".local", "state", "pi-sandbox");

const writeLegacyConfig = async (home: string) => {
  await mkdir(join(home, ".config", "pi-sandbox"), { recursive: true });

  await writeFile(legacyConfig(home), "{}");
};

const doctorChecks = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  await run(["sandbox", "doctor"], harness.deps);

  return doctorReport(harness.stdout()).checks;
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

  it("says at launch that an old policy file named by PI_SANDBOX_POLICY_FILE is no longer read", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const policy = join(harness.deps.home, "policy.json");

    await writeFile(policy, "{}");

    harness.deps.env.PI_SANDBOX_POLICY_FILE = policy;

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${policy} is no longer read, so its limits do not apply; move what you need into ${harness.userConfigFile}\n`,
    );
  });

  it("warns in the doctor about an old policy file", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    harness.deps.env.PI_SANDBOX_POLICY_FILE = "/old/policy.json";

    const checks = await doctorChecks(harness);

    expect(checks.find((check) => check.name === "old policy")).toMatchObject({
      status: "warn",
      detail: "/old/policy.json is no longer read, so its limits do not apply",
      hint: `move what you need into ${harness.userConfigFile}`,
    });
  });

  it("warns in the doctor about the old user config and the old state folder", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    await writeLegacyConfig(harness.deps.home);

    await mkdir(join(legacyState(harness.deps.home), "ca"), { recursive: true });

    const checks = await doctorChecks(harness);

    expect(checks.filter((check) => ["user config", "old state"].includes(check.name))).toMatchObject([
      {
        status: "warn",
        detail: "~/.config/pi-sandbox/config.json is no longer read",
        hint: `move it to ${harness.userConfigFile}`,
      },
      {
        status: "warn",
        detail: `~/.local/state/pi-sandbox is no longer used, the launcher keeps its state in ${harness.stateDir}`,
        hint: "delete it once no pi session started before the move runs",
      },
    ]);
  });

  it("reports no old-folder check in the doctor when neither old folder exists", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const checks = await doctorChecks(harness);

    expect(checks.map((check) => check.name)).toContain("host pi");
    expect(checks.filter((check) => ["user config", "old state"].includes(check.name))).toEqual([]);
  });
});

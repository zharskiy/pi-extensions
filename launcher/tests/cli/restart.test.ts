import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { type Backend, installIdOf, LABELS } from "../../backend/index.ts";
import type { CliDeps } from "../../cli/index.ts";
import { run, runPinata } from "../../cli/index.ts";
import { agentVolumeName, configVolumeName, mountedVolumes } from "../../container/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { exists } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness } from "./harness.ts";
import { fakeInput, fakeOutput, pause } from "./prompt/fake-tty.ts";

type Fake = ReturnType<typeof createFakeBackend>;

const SERVICES = [{ name: "db", command: ["db"], volumes: [{ name: "db-data", target: "/data" }] }];

const PACKAGE_CACHE = "~/.cache/pip";

const SUCCESS_TAIL = [
  "restarted the sandbox VM",
  "the next pi rebuilds the image and reinstalls your extensions",
];

const switchable = (fake: Fake) => {
  const vm = { up: false, starts: 0, stops: 0 };
  const backend: Backend = {
    ...fake.backend,
    detect: async () => (vm.up ? { available: true } : { available: false, reason: "stopped" }),
    vm: {
      ...fake.backend.vm,
      ensureRunning: async () => {
        vm.starts += 1;

        vm.up = true;
      },
      stop: async () => {
        vm.stops += 1;

        vm.up = false;

        return "stopped";
      },
    },
  };

  return { vm, backend };
};

const counted = (fake: Fake) => {
  const vm = { starts: 0, stops: 0 };
  const backend: Backend = {
    ...fake.backend,
    vm: {
      ...fake.backend.vm,
      ensureRunning: async () => {
        vm.starts += 1;
      },
      stop: async () => {
        vm.stops += 1;

        return "stopped";
      },
    },
  };

  return { vm, backend };
};

const withTty = (deps: CliDeps) => {
  const input = fakeInput();
  const output = fakeOutput(100, 60);

  return { input, output, deps: { ...deps, terminal: { ...deps.terminal, stdin: input, stderr: output } } };
};

const until = async (ready: () => boolean): Promise<void> => {
  if (ready()) {
    return;
  }

  await pause(5);

  return until(ready);
};

const answer = async (tty: ReturnType<typeof withTty>, reply: string) => {
  await until(() => /: $/.test(stripVTControlCharacters(tty.output.text())));

  tty.input.write(`${reply}\r`);
};

const serviceSetup = async () => {
  const fake = createFakeBackend();
  const { vm, backend } = counted(fake);
  const harness = await createHarness({ backend: () => backend, env: { PINATA_PLAIN: "1" } });
  const data = configVolumeName(harness.stateDir, "db-data");

  await harness.writeJson(harness.userConfigFile, { services: SERVICES });

  await fake.backend.ensureVolume(data);

  return { fake, vm, harness, data };
};

describe("pinata restart", () => {
  it("refuses while a pi session of any folder runs, and removes nothing", async () => {
    const fake = createFakeBackend();
    const { vm, backend } = counted(fake);
    const harness = await createHarness({ backend: () => backend });

    await run([], harness.deps);

    const volumes = fake.volumes.size;

    await registerLaunch(harness.stateDir, {
      launchId: "0123456789abcdef",
      ...(await processMark()),
      repoHash: sha256Hex("/elsewhere"),
      startedAt: 1,
    });

    expect(await runPinata(["restart"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("1 pi session is running in the sandbox VM");
    expect(harness.stderr()).toContain("exit them, then run pinata restart again");
    expect(fake.volumes.size).toBe(volumes);
    expect(vm.stops).toBe(0);
    expect(await exists(stateLayout(harness.stateDir).render)).toBe(true);
  });

  it("refuses while another install runs a pi session in the shared VM", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    fake.addContainer({
      name: "pinata-other",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.install]: "otherinstall" },
      state: "running",
      image: "x",
    });

    expect(await runPinata(["restart"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("in the sandbox VM");
    expect(harness.stdout()).toBe("");
  });

  it("removes every container, volume kind and image of this install, clears the records and restarts the VM", async () => {
    const fake = createFakeBackend();
    const { vm, backend } = counted(fake);
    const harness = await createHarness({ backend: () => backend });
    const layout = stateLayout(harness.stateDir);
    const agent = agentVolumeName(installIdOf(harness.stateDir));
    const legacy = `${agent}-0123456789ab`;
    const repo = { [LABELS.repoHash]: sha256Hex(harness.repoRoot), [LABELS.repoRoot]: harness.repoRoot };
    const overlay = `pinata-cache-${sha256Hex(harness.repoRoot).slice(0, 12)}-deadbeef`;
    const [cache] = mountedVolumes(sandboxConfig({ mounts: { volumes: [PACKAGE_CACHE] } }), harness.stateDir);
    const foreign = "pinata-cache-otherinstall-x";

    await harness.writeJson(harness.userConfigFile, { mounts: { volumes: [PACKAGE_CACHE] } });

    await run([], harness.deps);

    vm.starts = 0;

    await fake.backend.ensureVolume(legacy, repo);

    await fake.backend.ensureVolume(overlay, repo);

    await fake.backendFor("otherinstall").ensureVolume(foreign);

    fake.addContainer({
      name: "pinata-left",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", ...repo },
      state: "stopped",
      image: "x",
    });

    await mkdir(layout.renders, { recursive: true });

    await mkdir(layout.sync.directory, { recursive: true });

    await mkdir(layout.build, { recursive: true });

    await writeFile(layout.imageRecord, "{}");

    expect(fake.volumes.has(agent)).toBe(true);
    expect(fake.volumes.has(cache?.name ?? "")).toBe(true);
    expect(fake.localImages.size).toBeGreaterThan(0);
    expect(await runPinata(["restart"], harness.deps)).toBe(0);
    expect([...fake.volumes]).toEqual([foreign]);
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(fake.localImages.size).toBe(0);
    expect(harness.proxyStops()).toBeGreaterThan(0);
    expect(vm).toEqual({ starts: 2, stops: 1 });
    expect(await exists(layout.render)).toBe(false);
    expect(await exists(layout.renders)).toBe(false);
    expect(await exists(layout.sync.directory)).toBe(false);
    expect(await exists(layout.build)).toBe(false);
    expect(await exists(layout.imageRecord)).toBe(false);
    expect(await exists(join(harness.stateDir, "ca", "ca-cert.pem"))).toBe(true);

    const lines = harness.stdout().split("\n");
    const intro = lines.findIndex((line) => line.startsWith("pinata restart removes the sandbox's caches"));

    expect(lines.slice(intro + 1, -1)).toEqual([
      "removed 1 container",
      "removed 4 volumes: pi folder 2, build output 1, package caches 1",
      `removed ${fake.imageRemovals.length} images`,
      ...SUCCESS_TAIL,
    ]);
  });

  it("starts a stopped VM before it removes anything, then restarts it", async () => {
    const fake = createFakeBackend();
    const { vm, backend } = switchable(fake);
    const harness = await createHarness({ backend: () => backend });

    await fake.backend.ensureVolume(agentVolumeName(installIdOf(harness.stateDir)));

    expect(await runPinata(["restart"], harness.deps)).toBe(0);
    expect(vm).toEqual({ up: true, starts: 2, stops: 1 });
    expect(fake.volumes.size).toBe(0);
    expect(harness.stdout()).toBe(
      [
        "pinata restart removes the sandbox's caches (containers, volumes and images) and the next pi rebuilds them from your config",
        "removed 0 containers",
        "removed 1 volume: pi folder 1",
        "removed 0 images",
        ...SUCCESS_TAIL,
        "",
      ].join("\n"),
    );
  });

  it("says plainly when the VM does not start", async () => {
    const fake = createFakeBackend();
    const backend: Backend = {
      ...fake.backend,
      vm: {
        ...fake.backend.vm,
        ensureRunning: async () => {
          throw new Error("colima would not start");
        },
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await runPinata(["restart"], harness.deps)).not.toBe(0);
    expect(harness.stderr()).toContain("colima would not start");
  });

  it("refuses without a terminal when service data is at stake, and removes nothing", async () => {
    const { fake, vm, harness, data } = await serviceSetup();

    expect(await runPinata(["restart"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("the data of service db");
    expect(harness.stderr()).toContain("hint: run pinata restart at a terminal to confirm");
    expect(fake.volumes.has(data)).toBe(true);
    expect(vm.stops).toBe(0);
  });

  it("removes nothing when the answer is no", async () => {
    const { fake, vm, harness, data } = await serviceSetup();
    const tty = withTty(harness.deps);
    const exit = runPinata(["restart"], tty.deps);

    await answer(tty, "n");

    expect(await exit).toBe(130);
    expect(stripVTControlCharacters(tty.output.text())).toContain("- the data of service db");
    expect(fake.volumes.has(data)).toBe(true);
    expect(vm.stops).toBe(0);
    expect(harness.stdout()).toContain("nothing was removed\n");
  });

  it("removes the service data when the answer is yes", async () => {
    const { fake, vm, harness, data } = await serviceSetup();
    const tty = withTty(harness.deps);
    const exit = runPinata(["restart"], tty.deps);

    await answer(tty, "y");

    expect(await exit).toBe(0);
    expect(fake.volumes.has(data)).toBe(false);
    expect(vm.stops).toBe(1);
    expect(harness.stdout()).toContain("removed 1 volume: service data 1\n");
  });

  it("asks for the pi folder only while sessions.host is off", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => counted(fake).backend });
    const agent = agentVolumeName(installIdOf(harness.stateDir));

    await fake.backend.ensureVolume(agent);

    await harness.writeJson(harness.userConfigFile, { sessions: { host: false } });

    expect(await runPinata(["restart"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("the pi sessions kept in the sandbox while sessions.host is off");
    expect(fake.volumes.has(agent)).toBe(true);
  });

  it("asks for a shared volume no config entry names", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => counted(fake).backend });
    const orphan = configVolumeName(harness.stateDir, "old-service-data");

    await fake.backend.ensureVolume(orphan);

    expect(await runPinata(["restart"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("1 volume no config entry names");
    expect(fake.volumes.has(orphan)).toBe(true);
  });

  it("takes no options", async () => {
    const harness = await createHarness();

    expect(await runPinata(["restart", "--services"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pinata: unknown restart option "--services"\n  hint: pinata restart\n');
  });
});

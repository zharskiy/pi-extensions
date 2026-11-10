import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createColimaVm } from "../../backend/colima/vm.ts";
import { run } from "../../cli/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createHarness, sweepNow, writeColimaMounts, writeLimaMounts } from "../cli/harness.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { argvOf, createFakeRunner, type FakeCall } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

interface ColimaAnswers {
  running?: boolean;
  start?: { code: number; stderr: string };
  stop?: { code: number; stderr: string };
  missing?: boolean;
  staysDown?: boolean;
}

interface Setup {
  colima?: ColimaAnswers;
  profile?: boolean;
  config?: unknown;
  proxy?: boolean;
}

const LEFT_REPO = "d".repeat(64);

const STOP = "colima stop --profile pi-sandbox";

const STATUS = "colima status --profile pi-sandbox";

const START = "colima start --profile pi-sandbox --activate=false";

const setupWith = async (setup: Setup = {}) => {
  const answers = setup.colima ?? {};
  const fake = createFakeBackend();
  const vm = { running: answers.running === true };
  const events: string[] = [];
  const pauses: number[] = [];
  const answer = (call: FakeCall) => {
    const command = call.args[0];

    events.push(argvOf(call).join(" "));

    if (command === "status") {
      return { code: vm.running ? 0 : 1 };
    }

    if (command === "start") {
      vm.running = answers.start === undefined && answers.staysDown !== true;

      return answers.start ?? {};
    }

    return answers.stop ?? {};
  };
  const detect = async () =>
    vm.running && answers.staysDown !== true
      ? { available: true }
      : { available: false, reason: "socket missing" };
  const harness = await createHarness({
    backend: () => ({
      ...fake.backend,
      detect,
      status: async () => ({ socket: "/fake/docker.sock", profile: "pi-sandbox" }),
      vm: createColimaVm({
        home: harness.deps.home,
        stateDir: harness.stateDir,
        runner: harness.deps.runner,
        detect,
        pause: async (ms) => {
          pauses.push(ms);
        },
      }),
    }),
    respond: (call) => (call.file === "colima" && answers.missing !== true ? answer(call) : undefined),
    proxy: {
      stop: async () => {
        events.push("proxy stop");

        return setup.proxy === true;
      },
    },
  });

  if (setup.profile !== false) {
    await writeColimaMounts(harness.deps.home, [{ location: harness.root, writable: true }]);

    await writeLimaMounts(harness.deps.home, [{ location: harness.root, writable: true }]);
  }

  if (setup.config !== undefined) {
    await harness.writeJson(harness.userConfigFile, setup.config);
  }

  return {
    harness,
    fake,
    events,
    pauses,
    colimaCalls: () =>
      harness.calls.filter((call) => call.file === "colima").map((call) => argvOf(call).join(" ")),
  };
};

const liveSession = async (stateDir: string) =>
  registerLaunch(stateDir, {
    launchId: "00000000000000aa",
    ...(await processMark()),
    repoHash: sha256Hex("/elsewhere"),
    startedAt: 1,
  });

describe("a launch starts the stopped sandbox VM", () => {
  it("starts the pi-sandbox profile with one notice and launches", async () => {
    const context = await setupWith();

    expect(await run([], context.harness.deps)).toBe(0);
    expect(context.harness.stderr()).toContain("pi-sandbox: starting the sandbox VM\n");
    expect(context.colimaCalls()).toEqual([STATUS, START]);
    expect(context.fake.created).toHaveLength(1);
  });

  it("starts nothing without the pi-sandbox colima profile and says the engine is unreachable", async () => {
    const context = await setupWith({ profile: false });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        "pi-sandbox: the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock",
        "  hint: run launcher/install.sh or colima start --profile pi-sandbox --activate=false",
      ].join("\n"),
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("starts nothing when colima reports the VM running but the engine is unreachable", async () => {
    const context = await setupWith({ colima: { running: true, staysDown: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        "pi-sandbox: the sandbox VM is running but its engine at ~/.colima/pi-sandbox/docker.sock does not answer: socket missing",
        "  hint: run colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log",
      ].join("\n"),
    );
    expect(context.colimaCalls()).toEqual([STATUS]);
  });

  it("names the colima error when the start fails", async () => {
    const context = await setupWith({
      colima: { start: { code: 1, stderr: 'starting\nlevel=fatal msg="disk full"\n' } },
    });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        'pi-sandbox: could not start the sandbox VM: colima start failed: level=fatal msg="disk full"',
        "  hint: run colima start --profile pi-sandbox --activate=false and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log",
      ].join("\n"),
    );
    expect(context.fake.containers.size).toBe(0);
  });

  it("says the engine is unreachable when the VM started without it", async () => {
    const context = await setupWith({ colima: { staysDown: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pi-sandbox: the sandbox VM started but its engine is unreachable: socket missing\n",
    );
    expect(context.colimaCalls()).toEqual([STATUS, START]);
    expect(context.pauses).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it("names the missing colima", async () => {
    const context = await setupWith({ colima: { missing: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pi-sandbox: could not start the sandbox VM: colima: command not found\n  hint: run launcher/install.sh",
    );
  });

  it("never starts the VM for pi sandbox status or the sweep", async () => {
    const status = await setupWith();
    const gc = await setupWith();

    expect(await run(["sandbox", "status"], status.harness.deps)).toBe(0);
    expect(await sweepNow(gc.harness.deps)).toBe(0);
    expect(status.harness.stdout()).toContain("runtime: none (the sandbox VM engine is unreachable");
    expect([...status.colimaCalls(), ...gc.colimaCalls()]).toEqual([]);
  });
});

const stoppedVm = async (detections: boolean[] = []) => {
  const root = await realpath(await tempDir("vm"));
  const home = join(root, "home");
  const outside = join(root, "outside-share-repo");
  const state = { running: false, detections: [...detections] };

  await writeColimaMounts(home, [{ location: home, writable: true }]);

  await writeLimaMounts(home, [{ location: home, writable: true }]);

  const fake = createFakeRunner(async (call) => {
    if (call.args[0] === "status") {
      return { code: state.running ? 0 : 1 };
    }

    const mounts = call.args.flatMap((arg, index) => (call.args[index - 1] === "--mount" ? [arg] : []));

    if (mounts.length > 0) {
      await writeLimaMounts(
        home,
        mounts.map((mount) => ({ location: mount.replace(/:w$/, ""), writable: mount.endsWith(":w") })),
      );
    }

    state.running = true;

    return {};
  });
  const vm = createColimaVm({
    home,
    stateDir: join(home, "state"),
    runner: fake.runner,
    detect: async () => ({ available: state.detections.shift() ?? state.running }),
    pause: async () => undefined,
  });
  const colimaCalls = () => fake.calls.map((call) => argvOf(call).join(" "));
  const colimaEnvs = () => fake.calls.map((call) => call.options.env);

  return { home, outside, vm, colimaCalls, colimaEnvs };
};

describe("the stopped sandbox VM", () => {
  it("starts plainly, leaving any missing share to the shares stage", async () => {
    const context = await stoppedVm();
    const notices: string[] = [];

    await context.vm.ensureRunning((notice) => notices.push(notice));

    expect(context.colimaCalls()).toEqual([STATUS, START]);
    expect(notices).toEqual(["starting the sandbox VM"]);
    expect(await context.vm.coverage([{ path: context.outside, writable: true }])).toMatchObject({
      missing: [context.outside],
    });
  });

  it("runs every colima command against ~/.colima, whatever COLIMA_HOME says", async () => {
    const context = await stoppedVm();

    await context.vm.ensureRunning(() => undefined);

    await context.vm.size();

    expect(context.colimaEnvs()).toEqual([
      { COLIMA_HOME: join(context.home, ".colima") },
      { COLIMA_HOME: join(context.home, ".colima") },
      { COLIMA_HOME: join(context.home, ".colima") },
    ]);
  });

  it("starts nothing when another launch brought the engine up while this one waited for the VM lock", async () => {
    const context = await stoppedVm([false, true]);

    await context.vm.ensureRunning(() => undefined);

    expect(context.colimaCalls()).toEqual([]);
  });
});

describe("pi sandbox stop", () => {
  it("stops the VM, then sweeps what the sandboxes left, proxies included, and says the next pi starts it again", async () => {
    const context = await setupWith({ colima: { running: true }, proxy: true });
    const proxyDir = stateLayout(context.harness.stateDir).repo(LEFT_REPO).proxy;

    await mkdir(proxyDir.directory, { recursive: true });

    await writeFile(proxyDir.token, "f".repeat(64));

    expect(await run(["sandbox", "stop"], context.harness.deps)).toBe(0);
    expect(context.events).toEqual([STATUS, STOP, "proxy stop"]);
    expect(context.harness.stdout()).toBe(
      [
        `stopped the proxy of ${LEFT_REPO.slice(0, 12)}`,
        "stopped the sandbox VM (profile pi-sandbox); the next pi starts it again",
        "",
      ].join("\n"),
    );
  });

  it("refuses while a pi session runs and leaves the VM alone", async () => {
    const context = await setupWith({ colima: { running: true } });

    await liveSession(context.harness.stateDir);

    expect(await run(["sandbox", "stop"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toBe(
      [
        "pi-sandbox: 1 pi session is running; stopping the sandbox VM would end them",
        "  hint: exit them and run pi sandbox stop again",
        "",
      ].join("\n"),
    );
    expect(context.events).toEqual([STATUS]);
  });

  it("names the colima error when the stop fails", async () => {
    const context = await setupWith({ colima: { running: true, stop: { code: 1, stderr: "busy\n" } } });

    expect(await run(["sandbox", "stop"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pi-sandbox: could not stop the sandbox VM: colima stop failed: busy\n  hint: see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log",
    );
    expect(context.events).toEqual([STATUS, STOP]);
  });

  it("does nothing when the VM is already stopped", async () => {
    const context = await setupWith();

    expect(await run(["sandbox", "stop"], context.harness.deps)).toBe(0);
    expect(context.harness.stdout()).toBe("the sandbox VM is already stopped\n");
    expect(context.events).toEqual([STATUS]);
  });

  it("says there is no VM without the pi-sandbox profile", async () => {
    const context = await setupWith({ profile: false });

    expect(await run(["sandbox", "stop"], context.harness.deps)).toBe(0);
    expect(context.harness.stdout()).toBe("no sandbox VM: the colima profile pi-sandbox does not exist\n");
    expect(context.events).toEqual([]);
  });

  it("takes no arguments and is listed in the help", async () => {
    const context = await setupWith({ colima: { running: true } });

    expect(await run(["sandbox", "stop", "now"], context.harness.deps)).toBe(1);
    expect(await run(["sandbox", "help"], context.harness.deps)).toBe(0);
    expect(context.harness.stderr()).toContain('pi-sandbox: unknown stop option "now"\n');
    expect(context.harness.stdout()).toContain("  pi sandbox stop ");
    expect(context.events).toEqual([]);
  });
});

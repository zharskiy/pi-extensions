import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createColimaVm } from "../../backend/colima/vm.ts";
import { LABELS } from "../../backend/index.ts";
import { run, runPinata } from "../../cli/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex, stateLayout, withDirectoryLock } from "../../shared/index.ts";
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

const STOP = "colima stop --profile pinata";

const STATUS = "colima status --profile pinata";

const START = "colima start --profile pinata --activate=false";

const startWith = (shares: { location: string; writable: boolean }[]) =>
  [START, ...shares.map((share) => `--mount ${share.location}${share.writable ? ":w" : ""}`)].join(" ");

const setupWith = async (setup: Setup = {}) => {
  const answers = setup.colima ?? {};
  const fake = createFakeBackend();
  const vm = { running: answers.running === true };
  const events: string[] = [];
  const pauses: number[] = [];
  const answer = (call: FakeCall) => {
    const command = call.args[0];

    if (command === "ssh") {
      return { code: 1, stderr: "cat: /etc/pinata/extra.sha256: No such file or directory" };
    }

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
      status: async () => ({ socket: "/fake/docker.sock", profile: "pinata" }),
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
        const running = setup.proxy === true && !events.includes("proxy stop");

        events.push("proxy stop");

        return running;
      },
    },
  });

  if (setup.profile !== false) {
    await writeColimaMounts(harness.deps.home, harness.shares);

    await writeLimaMounts(harness.deps.home, harness.shares);
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
      harness.calls
        .filter((call) => call.file === "colima" && call.args[0] !== "ssh")
        .map((call) => argvOf(call).join(" ")),
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
  it("starts the pinata profile with one notice and launches", async () => {
    const context = await setupWith();

    expect(await run([], context.harness.deps)).toBe(0);
    expect(context.harness.stderr()).toContain("pinata: starting the sandbox VM\n");
    expect(context.colimaCalls()).toEqual([STATUS, startWith(context.harness.shares)]);
    expect(context.fake.created).toHaveLength(1);
  });

  it("starts nothing without the pinata colima profile and says the engine is unreachable", async () => {
    const context = await setupWith({ profile: false });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        "pinata: the sandbox VM does not exist: there is no colima profile pinata",
        "  hint: run pinata init, which creates it",
      ].join("\n"),
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("starts nothing when colima reports the VM running but the engine is unreachable", async () => {
    const context = await setupWith({ colima: { running: true, staysDown: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        "pinata: the sandbox VM is running but its engine at ~/.colima/pinata/docker.sock does not answer: socket missing",
        "  hint: run pinata stop, then pi again, and see ~/.colima/_lima/colima-pinata/ha.stderr.log",
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
        'pinata: could not start the sandbox VM: colima start failed: level=fatal msg="disk full"',
        `  hint: run ${START} --mount `,
      ].join("\n"),
    );
    expect(context.harness.stderr()).toContain(":w --mount ");
    expect(context.harness.stderr()).toContain(" and see ~/.colima/_lima/colima-pinata/ha.stderr.log");
    expect(context.fake.containers.size).toBe(0);
  });

  it("says the engine is unreachable when the VM started without it", async () => {
    const context = await setupWith({ colima: { staysDown: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pinata: the sandbox VM started but its engine is unreachable: socket missing\n",
    );
    expect(context.colimaCalls()).toEqual([STATUS, startWith(context.harness.shares)]);
    expect(context.pauses).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it("names the missing colima", async () => {
    const context = await setupWith({ colima: { missing: true } });

    expect(await run([], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pinata: could not start the sandbox VM: colima: command not found\n  hint: install colima, then run pinata init",
    );
  });

  it("never starts the VM for pinata status or the sweep", async () => {
    const status = await setupWith();
    const gc = await setupWith();

    expect(await runPinata(["status"], status.harness.deps)).toBe(0);
    expect(await sweepNow(gc.harness.deps)).toBe(0);
    expect(status.harness.stdout()).toContain("  Runtime:   the sandbox VM engine is unreachable");
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
  const outsideVm = () => fake.calls.filter((call) => call.args[0] !== "ssh");
  const colimaCalls = () => outsideVm().map((call) => argvOf(call).join(" "));
  const colimaEnvs = () => fake.calls.map((call) => call.options.env);

  return { home, outside, vm, colimaCalls, colimaEnvs };
};

const PLANNED = [{ location: "/Volumes/work", writable: true }];

describe("the stopped sandbox VM", () => {
  it("starts with the planned shares, leaving any missing share to the shares stage", async () => {
    const context = await stoppedVm();
    const notices: string[] = [];

    await context.vm.ensureRunning((notice) => notices.push(notice), PLANNED);

    expect(context.colimaCalls()).toEqual([STATUS, startWith(PLANNED)]);
    expect(notices).toEqual(["starting the sandbox VM"]);
    expect(await context.vm.coverage([{ path: context.outside, writable: true }])).toMatchObject({
      missing: [context.outside],
    });
  });

  it("runs every colima command against ~/.colima, whatever COLIMA_HOME says", async () => {
    const context = await stoppedVm();

    await context.vm.ensureRunning(() => undefined, PLANNED);

    await context.vm.size();

    expect(context.colimaEnvs()).toEqual([
      { COLIMA_HOME: join(context.home, ".colima") },
      { COLIMA_HOME: join(context.home, ".colima") },
      { COLIMA_HOME: join(context.home, ".colima") },
      { COLIMA_HOME: join(context.home, ".colima") },
    ]);
  });

  it("starts nothing when another launch brought the engine up while this one waited for the VM lock", async () => {
    const context = await stoppedVm([true]);

    await context.vm.ensureRunning(() => undefined, PLANNED);

    expect(context.colimaCalls()).toEqual([]);
  });

  it("waits for a VM change that holds the VM lock before it takes the engine as up", async () => {
    const context = await stoppedVm([true]);
    const order: string[] = [];
    const gate: { open?: () => void; entered?: () => void } = {};
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve;
    });
    const restart = withDirectoryLock(stateLayout(join(context.home, "state")).vmLock, async () => {
      gate.entered?.();

      await opened;

      order.push("restarted");
    });

    await entered;

    const ensured = context.vm.ensureRunning(() => undefined, PLANNED).then(() => order.push("ensured"));

    await sleep(100);

    gate.open?.();

    await Promise.all([restart, ensured]);

    expect(order).toEqual(["restarted", "ensured"]);
  });
});

describe("pinata stop", () => {
  it("stops the proxy and removes its token, stops the VM and says the next pi starts it again", async () => {
    const context = await setupWith({ colima: { running: true }, proxy: true });
    const proxyFiles = stateLayout(context.harness.stateDir).proxy;

    await mkdir(proxyFiles.directory, { recursive: true });

    await writeFile(proxyFiles.token, "f".repeat(64));

    expect(await runPinata(["stop"], context.harness.deps)).toBe(0);
    expect(context.events).toEqual(["proxy stop", STATUS, STOP]);
    expect(existsSync(proxyFiles.token)).toBe(false);
    expect(context.harness.stdout()).toBe(
      [
        "ok Cleaned up after ended pi sessions",
        "ok Stopped the sandbox VM",
        "",
        "The next pi starts it again.",
        "",
      ].join("\n"),
    );
  });

  it("refuses while a pi session runs and leaves the VM alone", async () => {
    const context = await setupWith({ colima: { running: true } });

    await liveSession(context.harness.stateDir);

    expect(await runPinata(["stop"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toBe(
      [
        "pinata: 1 pi session is running; stopping the sandbox VM would end them",
        "  hint: exit them and run pinata stop again",
        "",
      ].join("\n"),
    );
    expect(context.events).toEqual([STATUS]);
  });

  it("refuses for a session of another install, names its container and says how to remove a leftover", async () => {
    const context = await setupWith({ colima: { running: true } });

    context.fake.addContainer({
      name: "pinata-agent-other",
      labels: { [LABELS.managed]: "true", [LABELS.install]: "otherinstall", [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });

    expect(await runPinata(["stop"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toBe(
      [
        "pinata: 1 pi session is running (pinata-agent-other of another pinata install; remove a leftover with docker --context colima-pinata rm --force <name>); stopping the sandbox VM would end them",
        "  hint: exit them and run pinata stop again",
        "",
      ].join("\n"),
    );
  });

  it("names the colima error when the stop fails", async () => {
    const context = await setupWith({ colima: { running: true, stop: { code: 1, stderr: "busy\n" } } });

    expect(await runPinata(["stop"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pinata: could not stop the sandbox VM: colima stop failed: busy\n  hint: see ~/.colima/_lima/colima-pinata/ha.stderr.log",
    );
    expect(context.events).toEqual(["proxy stop", STATUS, STOP]);
  });

  it("does nothing when the VM is already stopped", async () => {
    const context = await setupWith();

    expect(await runPinata(["stop"], context.harness.deps)).toBe(0);
    expect(context.harness.stdout()).toBe("The sandbox VM is already stopped.\n");
    expect(context.events).toEqual(["proxy stop", STATUS]);
  });

  it("says there is no VM without the pinata profile", async () => {
    const context = await setupWith({ profile: false });

    expect(await runPinata(["stop"], context.harness.deps)).toBe(0);
    expect(context.harness.stdout()).toBe("There is no sandbox VM to stop.\n");
    expect(context.events).toEqual(["proxy stop"]);
  });

  it("takes no arguments and is listed in the help", async () => {
    const context = await setupWith({ colima: { running: true } });

    expect(await runPinata(["stop", "now"], context.harness.deps)).toBe(1);
    expect(await runPinata(["help"], context.harness.deps)).toBe(0);
    expect(context.harness.stderr()).toContain('pinata: unknown stop option "now"\n');
    expect(context.harness.stdout()).toMatch(/^pinata stop {2,}stop the services/m);
    expect(context.events).toEqual([]);
  });
});

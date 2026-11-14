import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createColimaVm } from "../../backend/colima/vm.ts";
import type { VmDesired, VmPhase, VmShare } from "../../backend/index.ts";
import type { RunResult } from "../../shared/index.ts";
import { createFakeRunner, type FakeCall } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

const GIB = 1024 ** 3;

interface Setup {
  profile?: { cpu: number; memory: number; disk?: number; mounts?: VmShare[] };
  running?: { cpu: number; memory: number; disk: number };
  lima?: VmShare[];
  status?: (call: FakeCall) => Partial<RunResult> | undefined;
  start?: Partial<RunResult>;
}

const mountsText = (shares: VmShare[], indent: string) =>
  shares.length === 0
    ? "mounts: []\n"
    : `mounts:\n${shares.map((share) => `${indent}- location: ${share.location}\n${indent}  writable: ${share.writable}`).join("\n")}\n`;

const setupWith = async (setup: Setup) => {
  const home = await tempDir("colima-apply-home");
  const stateDir = await tempDir("colima-apply-state");
  const profileDir = join(home, ".colima", "pi-sandbox");
  const limaDir = join(home, ".colima", "_lima", "colima-pi-sandbox");

  if (setup.profile !== undefined) {
    const { cpu, memory, disk, mounts = [] } = setup.profile;

    await mkdir(profileDir, { recursive: true });

    await writeFile(
      join(profileDir, "colima.yaml"),
      `cpu: ${cpu}\ndisk: ${disk ?? 60}\nmemory: ${memory} # GiB\n${mountsText(mounts, "  ")}`,
    );
  }

  if (setup.lima !== undefined) {
    await mkdir(limaDir, { recursive: true });

    await writeFile(join(limaDir, "lima.yaml"), `vmType: vz\n${mountsText(setup.lima, "")}`);
  }

  const state = { up: setup.running !== undefined };
  const fake = createFakeRunner((call) => {
    if (call.args[0] === "start" && setup.start !== undefined) {
      return setup.start;
    }

    if (call.args[0] === "start") {
      state.up = true;
    }

    if (call.args[0] !== "status") {
      return {};
    }

    const answered = setup.status?.(call);

    if (answered !== undefined) {
      return answered;
    }

    if (call.args.at(-1) !== "--json") {
      return { code: state.up ? 0 : 1 };
    }

    return setup.running === undefined
      ? { code: 1, stderr: "not running" }
      : {
          stdout: JSON.stringify({
            cpu: setup.running.cpu,
            memory: setup.running.memory * GIB,
            disk: setup.running.disk * GIB,
          }),
        };
  });
  const vm = createColimaVm({
    home,
    stateDir,
    runner: fake.runner,
    detect: async () => (state.up ? { available: true } : { available: false, reason: "socket missing" }),
    pause: async () => undefined,
  });
  const commands = () =>
    fake.calls
      .map((call) => call.args.join(" "))
      .filter((line) => !line.startsWith("status") && !line.startsWith("ssh"));

  return { home, vm, commands };
};

const SIZE = { cpus: 6, memoryGiB: 12, diskGiB: 80 };

const desiredOf = (home: string, exactShares = true): VmDesired => ({
  size: SIZE,
  shares: [{ location: join(home, "work"), writable: true }],
  exactShares,
});

const applied = async (env: Awaited<ReturnType<typeof setupWith>>, desired: VmDesired, busy = 0) => {
  const phases: VmPhase[] = [];
  const result = await env.vm.apply(desired, {
    busy: async () => busy,
    progress: (phase) => phases.push(phase),
  });

  return { result, phases };
};

describe("inspecting the sandbox VM", () => {
  it("knows an absent profile", async () => {
    const env = await setupWith({});

    expect(await env.vm.inspect()).toEqual({ state: "absent" });
  });

  it("reads a stopped profile's size and mounts from colima.yaml", async () => {
    const env = await setupWith({ profile: { cpu: 4, memory: 8, disk: 100, mounts: [] } });

    expect(await env.vm.inspect()).toEqual({
      state: "stopped",
      size: { cpus: 4, memoryGiB: 8, diskGiB: 100 },
      shares: [],
    });
  });

  it("reads a running VM's size from colima status in bytes and its shares from lima.yaml", async () => {
    const env = await setupWith({
      profile: { cpu: 2, memory: 4 },
      running: { cpu: 8, memory: 8, disk: 60 },
      lima: [{ location: "/Users/me/work", writable: true }],
    });

    expect(await env.vm.inspect()).toEqual({
      state: "running",
      size: { cpus: 8, memoryGiB: 8, diskGiB: 60 },
      shares: [{ location: "/Users/me/work", writable: true }],
    });
  });

  it("fails when colima does not answer within 3 seconds", async () => {
    const env = await setupWith({
      profile: { cpu: 2, memory: 4 },
      status: (call) => {
        expect(call.options.timeoutMs).toBe(3000);

        return { code: 124, timedOut: true };
      },
    });

    await expect(env.vm.inspect()).rejects.toThrow("colima did not answer within 3 seconds");
  });
});

describe("applying a size and shares to the sandbox VM", () => {
  it("creates an absent VM with vz, virtiofs, the size and the mounts", async () => {
    const env = await setupWith({});
    const { result, phases } = await applied(env, desiredOf(env.home));

    expect(result).toBe("created");
    expect(phases).toEqual(["creating", "waiting"]);
    expect(env.commands()).toEqual([
      `start --profile pi-sandbox --activate=false --mount ${join(env.home, "work")}:w --vm-type vz --mount-type virtiofs --cpu 6 --memory 12 --disk 80`,
    ]);
  });

  it("points a failed create at colima's log and pi sandbox init, not at a bare colima start", async () => {
    const env = await setupWith({ start: { code: 1, stderr: "disk full\n" } });

    await expect(
      env.vm.apply(desiredOf(env.home), { busy: async () => 0, progress: () => undefined }),
    ).rejects.toMatchObject({
      message: "could not create the sandbox VM: colima start failed: disk full",
      hint: "see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log, then run pi sandbox init again",
    });
  });

  it("leaves a stopped VM to the next launch", async () => {
    const env = await setupWith({ profile: { cpu: 2, memory: 4 } });

    expect((await applied(env, desiredOf(env.home))).result).toBe("stopped");
    expect(env.commands()).toEqual([]);
  });

  it("leaves a running VM that matches", async () => {
    const env = await setupWith({
      profile: { cpu: 6, memory: 12 },
      running: { cpu: 6, memory: 12, disk: 80 },
      lima: [],
    });
    const desired = { ...desiredOf(env.home), shares: [] };

    expect((await applied(env, desired)).result).toBe("unchanged");
    expect(env.commands()).toEqual([]);
  });

  it("defers while other pi sessions run", async () => {
    const env = await setupWith({
      profile: { cpu: 2, memory: 4 },
      running: { cpu: 2, memory: 4, disk: 60 },
      lima: [],
    });

    expect((await applied(env, desiredOf(env.home), 2)).result).toEqual({ deferred: 2 });
    expect(env.commands()).toEqual([]);
  });

  it("restarts with the changed size and the exact shares", async () => {
    const env = await setupWith({
      profile: { cpu: 6, memory: 4 },
      running: { cpu: 6, memory: 4, disk: 100 },
      lima: [{ location: "/Volumes/old", writable: true }],
    });
    const { result, phases } = await applied(env, desiredOf(env.home));

    expect(result).toBe("restarted");
    expect(phases).toEqual(["stopping", "starting", "waiting"]);
    expect(env.commands()).toEqual([
      "stop --profile pi-sandbox",
      `start --profile pi-sandbox --activate=false --mount ${join(env.home, "work")}:w --memory 12`,
    ]);
  });

  it("keeps the shares it has when the shares need only cover the wanted ones", async () => {
    const env = await setupWith({
      profile: { cpu: 6, memory: 12 },
      running: { cpu: 6, memory: 12, disk: 80 },
      lima: [{ location: "/Volumes/old", writable: true }],
    });
    const { result } = await applied(env, desiredOf(env.home, false));

    expect(result).toBe("restarted");
    expect(env.commands().at(-1)).toBe(
      `start --profile pi-sandbox --activate=false --mount /Volumes/old:w --mount ${join(env.home, "work")}:w`,
    );
  });
});

describe("starting a stopped VM at the configured size", () => {
  it("passes the values that differ from colima.yaml, and the disk only when it grows", async () => {
    const env = await setupWith({ profile: { cpu: 2, memory: 4, disk: 100 } });
    const notices: string[] = [];

    await env.vm.ensureRunning((notice) => notices.push(notice), [], { cpus: 4, memoryGiB: 4, diskGiB: 80 });

    expect(env.commands()).toEqual(["start --profile pi-sandbox --activate=false --cpu 4"]);
    expect(notices).toEqual([
      "vm.diskGiB 80 is below the sandbox VM's disk of 100 GiB; colima cannot shrink a disk, so it stays",
      "starting the sandbox VM",
    ]);
  });

  it("grows the disk on a cold start", async () => {
    const env = await setupWith({ profile: { cpu: 2, memory: 4, disk: 60 } });

    await env.vm.ensureRunning(() => undefined, [], { diskGiB: 80 });

    expect(env.commands()).toEqual(["start --profile pi-sandbox --activate=false --disk 80"]);
  });
});

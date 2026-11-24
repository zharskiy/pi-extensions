import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createColimaVm } from "../../backend/colima/vm.ts";
import type { VmTarget } from "../../backend/index.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

const GIB = 1024 ** 3;

const homeSharingNothing = async () => {
  const home = await tempDir("colima-size-home");
  const limaDir = join(home, ".colima", "_lima", "colima-pinata");

  await mkdir(limaDir, { recursive: true });

  await writeFile(join(limaDir, "lima.yaml"), "vmType: vz\nmounts: []\n");

  return home;
};

const vmWith = (respond: FakeResponder, stateDir = "/nonexistent", home = "/nonexistent") =>
  createColimaVm({
    home,
    stateDir,
    runner: createFakeRunner(respond).runner,
    detect: async () => ({ available: true }),
  });

describe("the sandbox VM size", () => {
  it("reads the size colima reports for the profile", async () => {
    const vm = vmWith((call) =>
      call.args.join(" ") === "status --profile pinata --json"
        ? { stdout: JSON.stringify({ cpu: 4, memory: 6 * GIB }) }
        : undefined,
    );

    expect(await vm.size()).toEqual({ cpus: 4, memoryGiB: 6 });
  });

  it("knows no size when colima is missing or reports none", async () => {
    const missing = vmWith(() => undefined);
    const stopped = vmWith(() => ({ code: 1, stderr: "not running" }));

    expect(await missing.size()).toBeUndefined();
    expect(await stopped.size()).toBeUndefined();
  });
});

describe("resizing the sandbox VM to the configured size", () => {
  const sized = async (reported: { cpu: number; memory: number; disk?: number }, busy = 0) => {
    const stateDir = await tempDir("colima-size");
    const vm = { size: reported };
    const fake = createFakeRunner((call) => {
      const command = call.args[0];

      if (command === "status") {
        return { stdout: JSON.stringify(vm.size) };
      }

      if (command === "start") {
        const flag = (name: string) => {
          const index = call.args.indexOf(name);

          return index === -1 ? undefined : Number(call.args[index + 1]);
        };

        vm.size = {
          cpu: flag("--cpu") ?? vm.size.cpu,
          memory: (flag("--memory") ?? vm.size.memory / GIB) * GIB,
          disk: (flag("--disk") ?? (vm.size.disk ?? 0) / GIB) * GIB,
        };
      }

      return {};
    });
    const colima = createColimaVm({
      home: await homeSharingNothing(),
      stateDir,
      runner: fake.runner,
      detect: async () => ({ available: true }),
      pause: async () => undefined,
    });
    const notices: string[] = [];
    const resize = (target: VmTarget) =>
      colima.reconcile(
        { size: target, shares: [], needs: [] },
        { busy: async () => ({ count: busy, others: [] }), report: (notice) => notices.push(notice) },
      );
    const changes = () =>
      fake.calls.map((call) => call.args.join(" ")).filter((line) => !line.startsWith("status"));

    return { resize, notices, changes };
  };

  const PROFILE = { cpu: 4, memory: 8 * GIB, disk: 60 * GIB };

  it("reads the disk size colima reports", async () => {
    const vm = vmWith(() => ({ stdout: JSON.stringify(PROFILE) }));

    expect(await vm.size()).toEqual({ cpus: 4, memoryGiB: 8, diskGiB: 60 });
  });

  it("restarts the profile with only the values that differ", async () => {
    const env = await sized(PROFILE);

    await env.resize({ cpus: 6, memoryGiB: 8, diskGiB: 80 });

    expect(env.changes()).toEqual([
      "stop --profile pinata",
      "start --profile pinata --activate=false --cpu 6 --disk 80",
    ]);
    expect(env.notices).toEqual(["restarting the sandbox VM to change its size to 6 CPUs, 80 GiB disk"]);
  });

  it("leaves a profile of the configured size alone, and does nothing without a target", async () => {
    const same = await sized(PROFILE);
    const unset = await sized(PROFILE);

    await same.resize({ cpus: 4, memoryGiB: 8, diskGiB: 60 });

    await unset.resize({});

    expect([...same.changes(), ...unset.changes()]).toEqual([]);
    expect([...same.notices, ...unset.notices]).toEqual([]);
  });

  it("never shrinks the disk and says so", async () => {
    const env = await sized(PROFILE);

    await env.resize({ diskGiB: 40 });

    expect(env.changes()).toEqual([]);
    expect(env.notices).toEqual([
      "vm.diskGiB 40 is below the sandbox VM's disk of 60 GiB; colima cannot shrink a disk, so it stays",
    ]);
  });

  it("keeps the size while another pi session runs and says when it changes", async () => {
    const env = await sized(PROFILE, 1);

    await env.resize({ memoryGiB: 12 });

    expect(env.changes()).toEqual([]);
    expect(env.notices).toEqual([
      "the sandbox VM will change its size to 12 GiB memory at the next launch with no other pi session running",
    ]);
  });

  it("skips a profile colima reports no size for", async () => {
    const vm = vmWith(
      () => ({ code: 1, stderr: "not running" }),
      await tempDir("colima-size"),
      await homeSharingNothing(),
    );
    const notices: string[] = [];

    await vm.reconcile(
      { size: { cpus: 2 }, shares: [], needs: [] },
      { busy: async () => ({ count: 0, others: [] }), report: (notice) => notices.push(notice) },
    );

    expect(notices).toEqual([]);
  });
});

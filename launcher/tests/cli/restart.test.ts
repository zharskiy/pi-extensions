import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LABELS, type VmInspect } from "../../backend/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { exists } from "../support/temp-dir.ts";
import { createPinata } from "./pinata/support.ts";

const DELETE = "colima delete --profile pinata --force --data";

const SIZE = { cpus: 4, memoryGiB: 8, diskGiB: 60 };

const SUCCESS = [
  "ok Removed the sandbox VM and its data",
  "ok Created the sandbox VM in 0s",
  "",
  "The next pi rebuilds the image and reinstalls your extensions.",
  "",
].join("\n");

const sandbox = async (state: VmInspect["state"], apply?: () => Promise<"created">) => {
  const vm: { state: VmInspect["state"]; created: number } = { state, created: 0 };
  const pinata = await createPinata({
    vm: {
      inspect: async () =>
        vm.state === "absent" ? { state: "absent" } : { state: vm.state, size: SIZE, shares: [] },
      apply: async () => {
        await apply?.();

        vm.created += 1;

        vm.state = "running";

        return "created";
      },
    },
    answer: (call) => {
      if ([call.file, ...call.args].join(" ") === DELETE) {
        vm.state = "absent";
      }

      return undefined;
    },
  });
  const layout = stateLayout(pinata.harness.stateDir);

  await writeFile(layout.salt, "salt");

  return { ...pinata, vm, layout, deletes: () => pinata.lines().filter((line) => line === DELETE).length };
};

const writeRecords = async (layout: ReturnType<typeof stateLayout>) => {
  await mkdir(layout.render, { recursive: true });

  await mkdir(layout.sync.directory, { recursive: true });

  await writeFile(layout.sync.baseline, "{}");

  await mkdir(layout.buildContext("build-x"), { recursive: true });

  await writeFile(layout.imageRecord, "{}");

  await writeFile(layout.grants, "{}");
};

describe("pinata restart", () => {
  it("refuses while a pi session runs in the VM, and deletes nothing", async () => {
    const pinata = await sandbox("running");

    await writeRecords(pinata.layout);

    pinata.busy();

    expect(await pinata.run("restart")).toBe(1);
    expect(pinata.harness.stderr()).toBe(
      "pinata: 1 pi session is running (other of another pinata install; remove a leftover with docker --context colima-pinata rm --force <name>) in the sandbox VM\n  hint: exit them, then run this again\n",
    );
    expect(pinata.harness.stdout()).toBe("");
    expect(pinata.deletes()).toBe(0);
    expect(pinata.vm).toEqual({ state: "running", created: 0 });
    expect(await exists(pinata.layout.render)).toBe(true);
  });

  it("deletes the VM and creates it again", async () => {
    const pinata = await sandbox("running");

    expect(await pinata.run("restart")).toBe(0);
    expect(pinata.harness.stdout()).toBe(SUCCESS);
    expect(pinata.harness.stderr()).toBe("");
    expect(pinata.deletes()).toBe(1);
    expect(pinata.vm).toEqual({ state: "running", created: 1 });
  });

  it("deletes a stopped VM and creates it again", async () => {
    const pinata = await sandbox("stopped");

    expect(await pinata.run("restart")).toBe(0);
    expect(pinata.harness.stdout()).toBe(SUCCESS);
    expect(pinata.deletes()).toBe(1);
    expect(pinata.vm).toEqual({ state: "running", created: 1 });
  });

  it("creates the VM when there is none", async () => {
    const pinata = await sandbox("absent");

    expect(await pinata.run("restart")).toBe(0);
    expect(pinata.harness.stdout()).toBe(SUCCESS.split("\n").slice(1).join("\n"));
    expect(pinata.deletes()).toBe(0);
    expect(pinata.vm).toEqual({ state: "running", created: 1 });
  });

  it("clears what the host recorded of the VM and keeps the settings, grants and CA", async () => {
    const pinata = await sandbox("running");
    const layout = pinata.layout;

    await writeRecords(layout);

    expect(await pinata.run("restart")).toBe(0);
    expect(await exists(layout.render)).toBe(false);
    expect(await exists(layout.sync.directory)).toBe(false);
    expect(await exists(layout.buildContext("build-x"))).toBe(false);
    expect(await exists(layout.imageRecord)).toBe(false);
    expect(await exists(layout.grants)).toBe(true);
    expect(await exists(layout.salt)).toBe(true);
    expect(await exists(layout.caCert)).toBe(true);
    expect(await exists(pinata.harness.userConfigFile)).toBe(true);
  });

  it("refuses when a pi session starts meanwhile, the way the uninstall does", async () => {
    const pinata = await sandbox("running");
    const fake = pinata.fake;
    const detections = { count: 0 };

    await writeRecords(pinata.layout);

    pinata.harness.deps.backend = () => ({
      ...fake.backend,
      detect: async () => {
        detections.count += 1;

        if (detections.count === 3) {
          fake.addContainer({
            name: "other",
            labels: { [LABELS.managed]: "true", [LABELS.install]: "other", [LABELS.role]: "agent" },
            state: "running",
            image: "x",
          });
        }

        return { available: true };
      },
    });

    expect(await pinata.run("restart")).toBe(1);
    expect(pinata.harness.stderr()).toContain(
      "x Could not remove the sandbox VM\npinata: a pi session started in the sandbox VM meanwhile (1 pi session is running",
    );
    expect(pinata.harness.stderr()).toContain(
      "so the sandbox network, proxy, services, volumes and images were kept\n  hint: exit it, then run this again\n",
    );
    expect(pinata.deletes()).toBe(0);
    expect(pinata.vm).toEqual({ state: "running", created: 0 });
    expect(await exists(pinata.layout.render)).toBe(true);
  });

  it("says the VM is gone and how to create it when creating it fails", async () => {
    const pinata = await sandbox("running", () =>
      Promise.reject(new LauncherError("colima would not start")),
    );

    expect(await pinata.run("restart")).toBe(1);
    expect(pinata.harness.stdout()).toBe("ok Removed the sandbox VM and its data\n");
    expect(pinata.harness.stderr()).toBe(
      [
        "x Could not create the VM after 0s.",
        "    colima would not start",
        "pinata: the sandbox VM is deleted and could not be created again",
        "  hint: fix that, then run pinata restart, which creates it",
        "",
      ].join("\n"),
    );
    expect(pinata.vm).toEqual({ state: "absent", created: 0 });
  });

  it("takes no options", async () => {
    const pinata = await sandbox("running");

    expect(await pinata.run("restart", "--services")).toBe(1);
    expect(pinata.harness.stderr()).toBe(
      'pinata: unknown restart option "--services"\n  hint: pinata restart\n',
    );
  });
});

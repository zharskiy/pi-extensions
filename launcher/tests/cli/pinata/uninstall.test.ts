import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { stateLayout } from "../../../shared/index.ts";
import { exists } from "../../support/temp-dir.ts";
import { createPinata, writePackages } from "./support.ts";

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

const installed = async (global: boolean) => {
  const pinata = await createPinata({ global, vm: { inspect: async () => RUNNING } });
  const zshrc = join(pinata.home, ".zshrc");
  const own = global ? "npm:@zharskiy/pinata@0.3.0" : pinata.packageDir;

  await writePackages(pinata.harness.hostAgentDir, [own, "npm:other"]);

  await mkdir(join(pinata.shim, ".."), { recursive: true });

  await writeFile(pinata.shim, "#!/bin/sh\nexec node '/x/launcher/bin/pi-sandbox.js' \"$@\"\n");

  await writeFile(zshrc, "alias ll=ls\n\n# pi-sandbox begin\nexport PATH=x\n# pi-sandbox end\n");

  await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

  return { ...pinata, zshrc };
};

describe("pinata uninstall", () => {
  it.each([false, true])("removes every part (global: %s)", async (global) => {
    const pinata = await installed(global);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(pinata.lines()).toContain("colima delete --profile pi-sandbox --force --data");
    expect(await exists(pinata.shim)).toBe(false);
    expect(await pinata.packages()).toEqual(["npm:other"]);
    expect(await exists(pinata.harness.stateDir)).toBe(false);
    expect(pinata.lines().at(-1) === "npm uninstall -g @zharskiy/pinata").toBe(global);
  });

  it("stops before the VM is deleted when releasing the sandbox fails, and names the way out", async () => {
    const pinata = await installed(false);
    const failing = pinata.harness.deps.backend();

    pinata.harness.deps.backend = () => ({
      ...failing,
      findContainers: () => Promise.reject(new Error("engine broke")),
    });

    await expect(pinata.run("uninstall")).rejects.toMatchObject({
      message: "engine broke",
      hint: expect.stringContaining("colima delete --profile pi-sandbox --force --data removes the VM"),
    });
    expect(pinata.lines()).not.toContain("colima delete --profile pi-sandbox --force --data");
    expect(await exists(pinata.shim)).toBe(true);
  });

  it.each([
    ["without the launcher's marker", false],
    ["that is pi's agent dir, marked or not", true],
  ])("refuses a state dir %s", async (_, agentDir) => {
    const pinata = await installed(false);
    const dir = agentDir ? pinata.harness.hostAgentDir : join(pinata.harness.root, "elsewhere");

    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, agentDir ? "salt" : "other"), "");

    pinata.harness.deps.env.PI_SANDBOX_STATE_DIR = dir;

    await expect(pinata.run("uninstall")).rejects.toThrow("does not look like the launcher's state");
    expect(await exists(join(dir, agentDir ? "settings.json" : "other"))).toBe(true);
  });
});

describe("pinata while a pi session runs in the VM", () => {
  it.each(["install", "update", "uninstall"])("refuses %s before it changes anything", async (command) => {
    const pinata = await createPinata({ global: true, vm: { inspect: async () => RUNNING } });
    const session = pinata.busy();

    pinata.harness.deps.env.PI_SANDBOX_STATE_DIR = join(pinata.harness.root, "none");

    await expect(pinata.run(command)).rejects.toThrow("1 pi session is running");
    expect(pinata.lines().filter((line) => / -g |delete/.test(line))).toEqual([]);
    expect(pinata.fake.containers.has(session)).toBe(true);
  });
});

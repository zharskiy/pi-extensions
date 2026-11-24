import { mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { LauncherError, stateLayout } from "../../../shared/index.ts";
import { exists } from "../../support/temp-dir.ts";
import { createPinata, writePackages } from "./support.ts";

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

const installed = async (global: boolean, hostPi?: false) => {
  const pinata = await createPinata({ global, hostPi, vm: { inspect: async () => RUNNING } });
  const zshrc = join(pinata.home, ".zshrc");
  const own = global ? "npm:@zharskiy/pinata@0.3.0" : pinata.packageDir;

  await writePackages(pinata.harness.hostAgentDir, [own, "npm:other"]);

  await mkdir(join(pinata.shim, ".."), { recursive: true });

  await symlink("/x/launcher/bin/pi.js", pinata.shim);

  await writeFile(zshrc, "alias ll=ls\n\n# pinata begin\nexport PATH=x\n# pinata end\n");

  await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

  return { ...pinata, zshrc };
};

describe("pinata uninstall", () => {
  it.each([false, true])("removes every part (global: %s)", async (global) => {
    const pinata = await installed(global);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(pinata.lines()).toContain("colima delete --profile pinata --force --data");
    expect(await exists(pinata.shim)).toBe(false);
    expect(await pinata.packages()).toEqual(["npm:other"]);
    expect(await exists(pinata.harness.stateDir)).toBe(false);
    expect(pinata.lines().at(-1) === "npm uninstall -g @zharskiy/pinata").toBe(global);
  });

  it("removes only the sandbox with --sandbox, and install brings it back as a plain rerun", async () => {
    const pinata = await createPinata({ vm: { inspect: async () => RUNNING } });
    const zshrc = join(pinata.home, ".zshrc");
    const link = join(pinata.home, ".local", "bin", "pinata");
    const read = () =>
      Promise.all([readFile(zshrc, "utf8"), readlink(link), readFile(pinata.harness.userConfigFile, "utf8")]);

    expect(await pinata.run("install", "--yes")).toBe(0);

    await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

    const installed = {
      packages: await pinata.packages(),
      shim: await readlink(pinata.shim),
      files: await read(),
    };
    const calls = pinata.lines().length;
    const printed = pinata.harness.stdout().length;

    expect(await pinata.run("uninstall", "--sandbox")).toBe(0);
    expect(pinata.lines().slice(calls)).toEqual(["colima delete --profile pinata --force --data"]);
    expect(await exists(pinata.shim)).toBe(false);
    expect(await exists(pinata.harness.stateDir)).toBe(false);
    expect(await pinata.packages()).toEqual(installed.packages);
    expect(await read()).toEqual(installed.files);
    expect(pinata.harness.stdout().slice(printed)).toBe(
      [
        "ok Removed the sandbox VM and its data",
        "ok Removed pinata's pi link (~/.local/bin/pi)",
        "ok Removed pinata's state",
        "",
        "The sandbox is uninstalled and pi runs on the host again. Kept on purpose:",
        "  Extensions:  pinata's extensions stay loaded in pi",
        `  Settings:    ${pinata.harness.userConfigFile}`,
        "  Bring back:  pinata install",
        "",
      ].join("\n"),
    );

    const rerun = pinata.lines().length;

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(
      pinata
        .lines()
        .slice(rerun)
        .filter((line) => / (install|remove) /.test(line)),
    ).toEqual([]);
    expect(await readlink(pinata.shim)).toBe(installed.shim);
    expect(await pinata.packages()).toEqual(installed.packages);
    expect(await read()).toEqual(installed.files);
  });

  it("prints one line per step and lists what it kept", async () => {
    const pinata = await installed(false);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        "ok Removed the sandbox VM and its data",
        "ok Removed pinata's pi link (~/.local/bin/pi)",
        "ok Removed pinata's extensions from pi",
        "ok Removed the PATH block from ~/.zshrc",
        "ok Removed pinata's state",
        "",
        "Pinata is uninstalled. Kept on purpose:",
        `  Settings:     ${pinata.harness.userConfigFile}`,
        "  pi sessions:  ~/.pi/agent/sessions",
        "  pi, colima:   remove them yourself if you no longer need them",
        "",
      ].join("\n"),
    );
    expect(pinata.harness.stderr()).toBe("");
  });

  it("finishes without a host pi and leaves pinata's extensions listed in pi's settings", async () => {
    const pinata = await installed(false, false);

    expect(await pinata.run("uninstall")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        "ok Removed the sandbox VM and its data",
        "ok Removed pinata's pi link (~/.local/bin/pi)",
        "! pi is not installed, so pinata's extensions stay listed in pi's settings (~/.pi/agent/settings.json)",
        "ok Removed the PATH block from ~/.zshrc",
        "ok Removed pinata's state",
        "",
        "Pinata is uninstalled. Kept on purpose:",
        `  Settings:     ${pinata.harness.userConfigFile}`,
        "  pi sessions:  ~/.pi/agent/sessions",
        "  pi, colima:   remove them yourself if you no longer need them",
        "",
      ].join("\n"),
    );
    expect(pinata.harness.stderr()).toBe("");
    expect(await pinata.packages()).toEqual([pinata.packageDir, "npm:other"]);
  });

  it("does not say pi runs on the host again when the host has no pi", async () => {
    const pinata = await installed(false, false);

    expect(await pinata.run("uninstall", "--sandbox")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        "ok Removed the sandbox VM and its data",
        "ok Removed pinata's pi link (~/.local/bin/pi)",
        "ok Removed pinata's state",
        "",
        "The sandbox is uninstalled. Kept on purpose:",
        "  Extensions:  pinata's extensions stay loaded in pi",
        `  Settings:    ${pinata.harness.userConfigFile}`,
        "  Bring back:  pinata install",
        "",
      ].join("\n"),
    );
  });

  it("does not say pi runs on the host again when it cannot put pi's own link back", async () => {
    const pinata = await createPinata({ vm: { inspect: async () => RUNNING } });
    const managed = join(pinata.harness.hostAgentDir, "bin", "pi");

    await mkdir(join(pinata.shim, ".."), { recursive: true });

    await symlink(managed, pinata.shim);

    expect(await pinata.run("install", "--yes")).toBe(0);

    await rm(pinata.shim);

    await writeFile(pinata.shim, "#!/bin/sh\necho mine\n");

    await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

    const printed = pinata.harness.stdout().length;

    expect(await pinata.run("uninstall", "--sandbox")).toBe(0);
    expect(pinata.harness.stdout().slice(printed)).toBe(
      [
        "ok Removed the sandbox VM and its data",
        `! Could not put pi's own link back, since ~/.local/bin/pi is taken; once it is free, run ln -s '${managed}' '${pinata.shim}'`,
        "ok Removed pinata's state",
        "",
        "The sandbox is uninstalled. Kept on purpose:",
        "  Extensions:  pinata's extensions stay loaded in pi",
        `  Settings:    ${pinata.harness.userConfigFile}`,
        "  Bring back:  pinata install",
        "",
      ].join("\n"),
    );
    expect(await readFile(pinata.shim, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("leaves pi alone", async () => {
    const pinata = await installed(true);
    const managed = join(pinata.harness.hostAgentDir, "install");
    const before = await readdir(managed, { recursive: true });

    expect(await pinata.run("uninstall")).toBe(0);
    expect(pinata.lines().filter((line) => line.includes("pi-coding-agent"))).toEqual([]);
    expect(await readdir(managed, { recursive: true })).toEqual(before);
    expect(await exists(join(pinata.harness.hostAgentDir, "bin", "pi"))).toBe(true);
  });

  it("keeps the VM when releasing the sandbox fails", async () => {
    const pinata = await installed(false);

    pinata.harness.deps.proxy = {
      ...pinata.harness.deps.proxy,
      stop: () => Promise.reject(new LauncherError("proxy would not stop")),
    };

    expect(await pinata.run("uninstall")).toBe(1);
    expect(pinata.harness.stderr()).toContain(
      "x Could not remove the sandbox VM\npinata: proxy would not stop\n",
    );
    expect(pinata.lines()).not.toContain("colima delete --profile pinata --force --data");
    expect(await exists(pinata.shim)).toBe(true);
  });

  it.each([
    ["without pinata's marker", false],
    ["that is pi's agent dir, marked or not", true],
  ])("refuses a state dir %s", async (_, agentDir) => {
    const pinata = await installed(false);
    const dir = agentDir ? pinata.harness.hostAgentDir : join(pinata.harness.root, "elsewhere");

    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, agentDir ? "salt" : "other"), "");

    pinata.harness.deps.env.PINATA_STATE_DIR = dir;

    expect(await pinata.run("uninstall")).toBe(1);
    expect(pinata.harness.stderr()).toContain("does not look like pinata's state");
    expect(await exists(join(dir, agentDir ? "settings.json" : "other"))).toBe(true);
  });
});

describe("pinata while a pi session runs in the VM", () => {
  it.each(["install", "update", "uninstall"])("refuses %s before it changes anything", async (command) => {
    const pinata = await createPinata({ global: true, vm: { inspect: async () => RUNNING } });
    const session = pinata.busy();

    pinata.harness.deps.env.PINATA_STATE_DIR = join(pinata.harness.root, "none");

    expect(await pinata.run(command)).toBe(1);
    expect(pinata.harness.stderr()).toContain("1 pi session is running");
    expect(pinata.lines().filter((line) => / -g |delete/.test(line))).toEqual([]);
    expect(pinata.fake.containers.has(session)).toBe(true);
  });
});

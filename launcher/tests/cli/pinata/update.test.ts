import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { launcherVersion } from "../../../cli/versions.ts";
import { createPinata } from "./support.ts";

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

describe("pinata update", () => {
  it("installs the package with npm, then passes on the exit code of the new pinata install", async () => {
    const pinata = await createPinata({
      global: true,
      answer: (call) => (call.file === process.execPath ? { code: 3 } : undefined),
    });
    const bin = join(pinata.packageDir, "launcher", "bin", "pinata.js");

    expect(await pinata.run("update", "0.5.0")).toBe(3);
    expect(pinata.lines().slice(-2)).toEqual([
      "npm install -g --legacy-peer-deps @zharskiy/pinata@0.5.0",
      `${process.execPath} ${bin} install --yes`,
    ]);
    expect(
      pinata.harness.calls
        .slice(-2)
        .map((call) => ({ interactive: call.interactive, env: call.options.env })),
    ).toEqual([
      { interactive: false, env: undefined },
      { interactive: true, env: { PINATA_UPDATED_FROM: await launcherVersion() } },
    ]);
    expect(pinata.harness.stdout()).toBe("");
  });

  it("shows npm's output when it fails and does not run the new install", async () => {
    const pinata = await createPinata({
      global: true,
      answer: (call) =>
        call.file === "npm" && call.args[0] === "install"
          ? { code: 1, stderr: "npm error code E404\n" }
          : undefined,
    });

    expect(await pinata.run("update", "0.5.0")).toBe(1);
    expect(pinata.harness.stderr()).toBe(
      [
        "x Could not update pinata",
        "  npm error code E404",
        "pinata: npm install -g --legacy-peer-deps @zharskiy/pinata@0.5.0 exited with code 1",
        "",
      ].join("\n"),
    );
    expect(pinata.harness.calls.filter((call) => call.file === process.execPath)).toEqual([]);
  });

  it("names the update and the new version when the new install runs", async () => {
    const pinata = await createPinata({ global: true, vm: { inspect: async () => RUNNING } });
    const version = await launcherVersion();

    pinata.harness.deps.env.PINATA_UPDATED_FROM = "0.0.1";

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        `ok Updated pinata 0.0.1 -> ${version}`,
        "ok Registered pinata's extensions with pi",
        "ok Linked pi to the sandbox (~/.local/bin/pi)",
        "ok Added ~/.local/bin to PATH in ~/.zshrc",
        "",
        `Pinata is up to date (${version}).`,
        "",
      ].join("\n"),
    );
  });

  it("refuses in a checkout", async () => {
    const pinata = await createPinata();

    expect(await pinata.run("update")).toBe(1);
    expect(pinata.harness.stderr()).toContain("pinata: this is a checkout: git pull, then pinata install");
    expect(pinata.lines()).toEqual([]);
  });
});

import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { stateLayout } from "../../../shared/index.ts";
import { createPinata } from "./support.ts";

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

const withoutHostPi = async () => {
  const pinata = await createPinata({ hostPi: false, vm: { inspect: async () => RUNNING } });

  await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

  return pinata;
};

describe("pinata commands without a host pi", () => {
  it.each([
    ["status"],
    ["list"],
    ["config"],
    ["stop"],
    ["restart"],
    ["uninstall", "--sandbox"],
    ["uninstall"],
  ])("runs %s", async (...argv) => {
    const pinata = await withoutHostPi();

    expect(await pinata.run(...argv)).toBe(0);
    expect(pinata.harness.stderr()).not.toContain("pi is not installed on the host");
  });

  it("runs doctor and reports the missing pi in its check", async () => {
    const pinata = await withoutHostPi();

    await pinata.run("doctor");

    expect(pinata.harness.stdout()).toContain("pi is not installed on the host");
    expect(pinata.harness.stderr()).not.toContain("pi is not installed on the host");
  });
});

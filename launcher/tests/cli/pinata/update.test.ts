import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPinata } from "./support.ts";

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
  });

  it("refuses in a checkout", async () => {
    const pinata = await createPinata();

    expect(await pinata.run("update")).toBe(1);
    expect(pinata.harness.stderr()).toContain("pinata: this is a checkout: git pull, then pinata install");
    expect(pinata.lines()).toEqual([]);
  });
});

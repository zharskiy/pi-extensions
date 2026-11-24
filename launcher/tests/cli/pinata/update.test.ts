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

    expect(await pinata.run("update")).toBe(3);
    expect(pinata.lines().slice(-2)).toEqual([
      "npm install -g --legacy-peer-deps @zharskiy/pinata@latest",
      `${process.execPath} ${bin} install --yes`,
    ]);
    expect(
      pinata.harness.calls
        .slice(-2)
        .map((call) => ({ interactive: call.interactive, env: call.options.env })),
    ).toEqual([
      { interactive: false, env: undefined },
      { interactive: true, env: undefined },
    ]);
    expect(pinata.harness.stdout()).toBe("ok Updated pinata\n");
  });

  it("shows npm's output when it fails and does not run the new install", async () => {
    const pinata = await createPinata({
      global: true,
      answer: (call) =>
        call.file === "npm" && call.args[0] === "install"
          ? { code: 1, stderr: "npm error code E404\n" }
          : undefined,
    });

    expect(await pinata.run("update")).toBe(1);
    expect(pinata.harness.stderr()).toBe(
      [
        "x Could not update pinata",
        "  npm error code E404",
        "pinata: npm install -g --legacy-peer-deps @zharskiy/pinata@latest exited with code 1",
        "",
      ].join("\n"),
    );
    expect(pinata.harness.calls.filter((call) => call.file === process.execPath)).toEqual([]);
  });

  it("refuses in a checkout", async () => {
    const pinata = await createPinata();

    expect(await pinata.run("update")).toBe(1);
    expect(pinata.harness.stderr()).toContain("pinata: this is a checkout: git pull, then pinata install");
    expect(pinata.lines()).toEqual([]);
  });
});

import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherVersion } from "../../../cli/versions.ts";
import { exists } from "../../support/temp-dir.ts";
import { createPinata } from "./support.ts";

const BLOCK = (home: string) =>
  `# pi-sandbox begin\nexport PATH='${home}/.local/bin':"$PATH"\n# pi-sandbox end\n`;

const BROKEN = ["# pi-sandbox begin\n", `${"# pi-sandbox begin\nx\n# pi-sandbox end\n".repeat(2)}`];

describe("pinata install", () => {
  it.each([
    [false, "pi-sandbox-dev.js", "alias ll=\xff\n"],
    [true, "pi-sandbox.js", "alias ll=\xff"],
  ])(
    "installs (global: %s), a rerun changes nothing, and uninstall restores the rc file's bytes",
    async (global, bin, rc) => {
      const pinata = await createPinata({ global });
      const zshrc = join(pinata.home, ".zshrc");
      const settings = join(pinata.harness.hostAgentDir, "settings.json");

      await writeFile(zshrc, rc, "latin1");

      expect(await pinata.run("install", "--yes")).toBe(0);
      expect(await pinata.packages()).toEqual([
        global ? `npm:@zharskiy/pinata@${await launcherVersion()}` : pinata.packageDir,
      ]);
      expect(await readlink(pinata.shim)).toBe(join(pinata.packageDir, "launcher", "bin", bin));
      expect(await readFile(zshrc, "latin1")).toBe(`${rc}\n${BLOCK(pinata.home)}`);

      const before = { calls: pinata.lines().length, shim: (await lstat(pinata.shim)).ino };
      const files = await Promise.all([zshrc, settings].map((file) => readFile(file, "latin1")));

      expect(await pinata.run("install", "--yes")).toBe(0);
      expect(
        pinata
          .lines()
          .slice(before.calls)
          .filter((line) => / (install|remove) /.test(line)),
      ).toEqual([]);
      expect((await lstat(pinata.shim)).ino).toBe(before.shim);
      expect(await Promise.all([zshrc, settings].map((file) => readFile(file, "latin1")))).toEqual(files);

      await writeFile(join(pinata.harness.stateDir, "salt"), "salt");

      expect(await pinata.run("uninstall")).toBe(0);
      expect(await readFile(zshrc, "latin1")).toBe(rc);
    },
  );

  it.each([
    ["a file of its own", (shim: string) => writeFile(shim, "#!/bin/sh\necho mine\n")],
    ["npm's pi link", (shim: string) => symlink("../lib/node_modules/pi/dist/cli.js", shim)],
  ])("refuses %s at ~/.local/bin/pi before it installs pi, and leaves it there", async (_, put) => {
    const pinata = await createPinata({ hostPi: false });

    await mkdir(join(pinata.shim, ".."), { recursive: true });

    await put(pinata.shim);

    await expect(pinata.run("install", "--pi", "1.6.0")).rejects.toMatchObject({
      hint: "move it away and run this again",
    });
    expect(pinata.lines().filter((line) => line.startsWith("npm"))).toEqual([]);
    expect(await pinata.packages()).toEqual([]);
    expect(await exists(join(pinata.home, ".zshrc"))).toBe(false);
  });

  it("replaces main's wrapper, and puts back on uninstall the managed link it replaced", async () => {
    const pinata = await createPinata();
    const managed = join(pinata.harness.hostAgentDir, "bin", "pi");
    const target = join(pinata.packageDir, "launcher", "bin", "pi-sandbox-dev.js");

    await mkdir(join(pinata.shim, ".."), { recursive: true });

    await writeFile(pinata.shim, "#!/bin/sh\nexec node '/x/launcher/bin/pi-sandbox-dev.js' \"$@\"\n");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readlink(pinata.shim)).toBe(target);

    await rm(pinata.shim);

    await symlink(managed, pinata.shim);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readlink(pinata.shim)).toBe(target);

    await writeFile(join(pinata.harness.stateDir, "salt"), "salt");

    expect(await pinata.run("uninstall")).toBe(0);
    expect(await readlink(pinata.shim)).toBe(managed);
  });

  it.each(BROKEN)("leaves an rc file with a broken marker pair alone", async (text) => {
    const pinata = await createPinata();
    const zshrc = join(pinata.home, ".zshrc");

    await writeFile(zshrc, text);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(zshrc, "utf8")).toBe(text);
    expect(pinata.harness.stdout()).toContain(
      `shell: ${zshrc} has a "# pi-sandbox begin" or "# pi-sandbox end" line`,
    );
  });

  it.each(["install", "update"])(
    "refuses %s --pi while pi's managed install exists, before npm runs",
    async (command) => {
      const pinata = await createPinata({ global: true });

      await expect(pinata.run(command, "--pi", "1.2.3")).rejects.toThrow("pi's managed install");
      expect(pinata.lines().filter((line) => line.includes(" -g "))).toEqual([]);
    },
  );

  it("refuses an invalid --config before it changes anything, and writes a valid one", async () => {
    const pinata = await createPinata();
    const given = join(pinata.harness.root, "team.json");

    await writeFile(given, JSON.stringify({ workspaceRoot: 5 }));

    await expect(pinata.run("install", "--config", given)).rejects.toThrow("workspaceRoot");
    expect(pinata.lines()).toEqual([]);
    expect(await exists(pinata.shim)).toBe(false);
    expect(await exists(join(pinata.home, ".zshrc"))).toBe(false);

    await writeFile(given, JSON.stringify({ workspaceRoot: pinata.harness.repoRoot }));

    expect(await pinata.run("install", "--config", given)).toBe(0);
    expect(JSON.parse(await readFile(pinata.harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoot: pinata.harness.repoRoot,
    });
  });
});

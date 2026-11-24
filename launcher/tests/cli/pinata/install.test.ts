import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../../backend/index.ts";
import { launcherVersion } from "../../../cli/versions.ts";
import { exists } from "../../support/temp-dir.ts";
import { createPinata } from "./support.ts";

const BLOCK = (home: string) => `# pinata begin\nexport PATH='${home}/.local/bin':"$PATH"\n# pinata end\n`;

const BROKEN = ["# pinata begin\n", `${"# pinata begin\nx\n# pinata end\n".repeat(2)}`];

const RUNNING: VmInspect = { state: "running", size: { cpus: 4, memoryGiB: 8, diskGiB: 60 }, shares: [] };

describe("pinata install", () => {
  it("prints one line per step and a closing block, and a rerun says only that nothing changed", async () => {
    const pinata = await createPinata({ vm: { inspect: async () => RUNNING } });

    expect(await pinata.run("install", "--yes")).toBe(0);

    const printed = pinata.harness.stdout().length;

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        "ok Registered pinata's extensions with pi",
        "ok Linked pi to the sandbox (~/.local/bin/pi)",
        "ok Linked pinata to this checkout (~/.local/bin/pinata)",
        "ok Added ~/.local/bin to PATH in ~/.zshrc",
        "",
        "Pinata is installed.",
        "  Start:     open a new terminal, then cd <your repo> && pi",
        `  Settings:  ${pinata.harness.userConfigFile}`,
        "  Check:     pinata doctor",
        "Pinata is already installed. Nothing changed.",
        "",
      ].join("\n"),
    );
    expect(pinata.harness.stdout().slice(printed)).toBe("Pinata is already installed. Nothing changed.\n");
    expect(pinata.harness.stderr()).toBe("");
  });

  it("installs colima quietly, and shows brew's output when it fails", async () => {
    const pinata = await createPinata({
      answer: (call) =>
        call.file === "colima"
          ? { code: 127 }
          : call.file === "brew" && call.args[0] === "install"
            ? {
                code: 1,
                stdout: `${Array.from({ length: 30 }, (_, line) => `line ${line}`).join("\n")}\n`,
                stderr: "Error: no network\n",
              }
            : undefined,
    });

    expect(await pinata.run("install", "--yes")).toBe(1);
    expect(pinata.harness.calls.filter((call) => call.interactive)).toEqual([]);
    expect(pinata.harness.stdout()).toBe("");
    expect(pinata.harness.stderr()).toBe(
      [
        "x Could not install colima",
        ...Array.from({ length: 19 }, (_, line) => `  line ${line + 11}`),
        "  Error: no network",
        "pinata: brew install colima exited with code 1",
        "",
      ].join("\n"),
    );
    expect(await exists(pinata.shim)).toBe(false);
  });

  it.each([
    [false, "pi-dev.js", "alias ll=\xff\n"],
    [true, "pi.js", "alias ll=\xff"],
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
  ])("refuses %s at ~/.local/bin/pi before it changes anything, and leaves it there", async (_, put) => {
    const pinata = await createPinata();

    await mkdir(join(pinata.shim, ".."), { recursive: true });

    await put(pinata.shim);

    expect(await pinata.run("install", "--yes")).toBe(1);
    expect(pinata.harness.stderr()).toContain("  hint: move it away and run this again");
    expect(pinata.lines().filter((line) => line.startsWith("npm"))).toEqual([]);
    expect(await pinata.packages()).toEqual([]);
    expect(await exists(join(pinata.home, ".zshrc"))).toBe(false);
  });

  it("puts back on uninstall the managed link it replaced", async () => {
    const pinata = await createPinata();
    const managed = join(pinata.harness.hostAgentDir, "bin", "pi");
    const target = join(pinata.packageDir, "launcher", "bin", "pi-dev.js");

    await mkdir(join(pinata.shim, ".."), { recursive: true });

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
      '! Left ~/.zshrc as it is: it has a "# pinata begin" or "# pinata end" line without its pair\n',
    );
  });

  it.each([["install", "--yes"], ["update"]])(
    "refuses %s without a host pi before it changes anything",
    async (command, ...args) => {
      const pinata = await createPinata({ global: true, hostPi: false });
      const agentDir = pinata.harness.hostAgentDir;

      expect(await pinata.run(command, ...args)).toBe(1);
      expect(pinata.harness.stderr()).toBe(
        [
          `pinata: pi is not installed on the host (no managed pi in ${agentDir} and no pi in npm's global packages), and pinata does not install it`,
          `  hint: install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) or with npm install -g @earendil-works/pi-coding-agent, then run pinata ${command} again`,
          "",
        ].join("\n"),
      );
      expect(pinata.harness.calls.filter((call) => call.interactive)).toEqual([]);
      expect(await pinata.packages()).toEqual([]);
      expect(await exists(pinata.shim)).toBe(false);
      expect(await exists(join(pinata.home, ".zshrc"))).toBe(false);
    },
  );

  it("refuses an invalid --config before it changes anything, and writes a valid one", async () => {
    const pinata = await createPinata();
    const given = join(pinata.harness.root, "team.json");

    await writeFile(given, JSON.stringify({ workspaceRoot: 5 }));

    expect(await pinata.run("install", "--config", given)).toBe(1);
    expect(pinata.harness.stderr()).toContain("workspaceRoot");
    expect(pinata.lines()).toEqual([]);
    expect(await exists(pinata.shim)).toBe(false);
    expect(await exists(join(pinata.home, ".zshrc"))).toBe(false);

    await writeFile(given, JSON.stringify({ workspaceRoot: pinata.harness.repoRoot }));

    expect(await pinata.run("install", "--config", given)).toBe(0);
    expect(JSON.parse(await readFile(pinata.harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoot: pinata.harness.repoRoot,
    });
  });

  it("links ~/.local/bin/pinata to the checkout, and uninstall removes the link", async () => {
    const pinata = await createPinata();
    const link = join(pinata.home, ".local", "bin", "pinata");
    const target = join(pinata.packageDir, "launcher", "bin", "pinata-dev.js");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readlink(link)).toBe(target);
    expect(pinata.harness.stdout()).toContain("ok Linked pinata to this checkout (~/.local/bin/pinata)\n");

    await writeFile(join(pinata.harness.stateDir, "salt"), "salt");

    expect(await pinata.run("uninstall")).toBe(0);
    expect(await exists(link)).toBe(false);
  });

  it("adds no pinata link to an npm install and removes a checkout's", async () => {
    const pinata = await createPinata({ global: true });
    const link = join(pinata.home, ".local", "bin", "pinata");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await exists(link)).toBe(false);

    await symlink("/elsewhere/launcher/bin/pinata-dev.js", link);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await exists(link)).toBe(false);
  });

  it("refuses another file at ~/.local/bin/pinata before it changes anything, and uninstall leaves it there", async () => {
    const pinata = await createPinata();
    const link = join(pinata.home, ".local", "bin", "pinata");

    await mkdir(join(link, ".."), { recursive: true });

    await writeFile(link, "#!/bin/sh\necho mine\n");

    expect(await pinata.run("install", "--yes")).toBe(1);
    expect(pinata.harness.stderr()).toBe(
      `pinata: ${link} is not pinata's link\n  hint: move it away and run this again\n`,
    );
    expect(pinata.lines().filter((line) => line.startsWith("npm"))).toEqual([]);
    expect(await exists(pinata.shim)).toBe(false);

    await mkdir(pinata.harness.stateDir, { recursive: true });

    await writeFile(join(pinata.harness.stateDir, "salt"), "salt");

    expect(await pinata.run("uninstall")).toBe(0);
    expect(await readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it.each([
    [["install", "extra"], 'pinata: install: unexpected argument "extra"'],
    [["install", "--force"], "pinata: install: Unknown option '--force'"],
    [["update", "1.0.0", "2.0.0"], 'pinata: update: unexpected argument "2.0.0"'],
    [["update", "--yes"], "pinata: update: Unknown option '--yes'"],
    [["uninstall", "--yes"], 'pinata: unknown uninstall option "--yes"'],
  ])("refuses %j and names its usage", async (argv, message) => {
    const pinata = await createPinata();

    expect(await pinata.run(...argv)).toBe(1);
    expect(pinata.harness.stderr()).toMatch(
      new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\n  hint: pinata ${argv[0]}`),
    );
    expect(pinata.lines()).toEqual([]);
  });

  it("prints the usage of install, update and uninstall for --help", async () => {
    const pinata = await createPinata();

    expect(await pinata.run("install", "--help")).toBe(0);
    expect(await pinata.run("update", "-h")).toBe(0);
    expect(await pinata.run("uninstall", "--help")).toBe(0);
    expect(pinata.harness.stdout()).toBe(
      [
        "pinata install [--config <file>] [--yes]  set up pinata's package in host pi, the pi link, PATH and the sandbox VM; needs pi installed on the host, --config writes that file as the config, --yes asks nothing",
        "pinata update [<version>]  install that pinata version with npm (latest without one), then its pinata install --yes",
        "pinata uninstall [--sandbox]  remove the sandbox VM, pinata's state, its links, its PATH block and its package in host pi; your config, sessions, pi and colima stay; --sandbox removes only the sandbox VM, the pi link and pinata's state, so pi runs host pi",
        "",
      ].join("\n"),
    );
    expect(pinata.lines()).toEqual([]);
  });
});
